import XCTest
import WhisperKit
@testable import MeetingNotesSpeech

final class WhisperKitTranscriptionTests: XCTestCase {
    private func word(_ text: String, _ start: Float, _ end: Float) -> WordTiming {
        WordTiming(word: text, tokens: [], start: start, end: end, probability: 1)
    }

    func testVocabularyIsTrimmedDeduplicatedAndBounded() {
        XCTAssertEqual(vocabulary(["  SLSA ", "", "slsa", "two\nlines", String(repeating: "x", count: 81), "Priya"]), ["SLSA", "Priya"])
        XCTAssertEqual(vocabulary(nil), [])
        XCTAssertEqual(vocabulary((0..<500).map { "Term \($0)" }).count, 100)
        XCTAssertEqual(vocabulary((0..<500).map { "Term \($0)" }).first, "Term 0")
    }

    func testLanguageCodeDropsTheRegionAndRejectsUnknownLanguages() throws {
        XCTAssertEqual(try WhisperKitTranscription.languageCode("en-US"), "en")
        XCTAssertEqual(try WhisperKitTranscription.languageCode("de_DE"), "de")
        XCTAssertEqual(try WhisperKitTranscription.languageCode("JA"), "ja")
        XCTAssertEqual(try WhisperKitTranscription.languageCode(nil), "en")
        XCTAssertThrowsError(try WhisperKitTranscription.languageCode("xx-YY"))
        XCTAssertThrowsError(try WhisperKitTranscription.languageCode(""))
    }

    func testPromptKeepsTheFirstTermsWithinTheTokenBudgetAndDropsSpecialTokens() {
        // One token per character; 60000 stands in for a special token.
        let encode: (String) -> [Int] = { text in text.unicodeScalars.map { $0 == "|" ? 60000 : Int($0.value) } }
        XCTAssertNil(WhisperKitTranscription.promptTokens(nil, encode: encode, specialTokenBegin: 50000))
        XCTAssertNil(WhisperKitTranscription.promptTokens(["  "], encode: encode, specialTokenBegin: 50000))
        let tokens = WhisperKitTranscription.promptTokens(["SLSA", "Pri|ya"], encode: encode, specialTokenBegin: 50000)
        XCTAssertEqual(tokens.map { String(String.UnicodeScalarView($0.compactMap(UnicodeScalar.init))) }, " Glossary: SLSA, Priya")
        let many = (0..<100).map { "Term number \($0)" }
        let bounded = WhisperKitTranscription.promptTokens(many, encode: encode, specialTokenBegin: 50000) ?? []
        XCTAssertLessThanOrEqual(bounded.count, WhisperKitTranscription.maxPromptTokens)
        let text = String(String.UnicodeScalarView(bounded.compactMap(UnicodeScalar.init)))
        XCTAssertTrue(text.hasPrefix(" Glossary: Term number 0, Term number 1"))
        XCTAssertFalse(text.contains("Term number 99"))
        // A single term too long for the budget leaves no prompt at all.
        let huge = String(repeating: "y", count: 80)
        XCTAssertNil(WhisperKitTranscription.promptTokens([huge], encode: { _ in Array(repeating: 1, count: 300) }, specialTokenBegin: 50000))
    }

    func testWordsKeepTheirOwnTimesAndAreOrderedAcrossChunks() throws {
        // Chunks are decoded concurrently, so a later chunk can arrive first.
        let later = TranscriptionSegment(start: 30, end: 32, text: " second chunk", words: [word(" second", 30.0, 30.6), word(" chunk", 30.6, 31.2)])
        let earlier = TranscriptionSegment(start: 0, end: 2, text: " Hello there.", words: [word(" Hello", 0.2, 0.6), word(" ", 0.6, 0.6), word(" there.", 0.6, 1.1)])
        let words = try WhisperKitTranscription.timedWords([later, earlier], duration: 40)
        XCTAssertEqual(words.map(\.text), ["Hello", "there.", "second", "chunk"])
        XCTAssertEqual(words.map(\.start), [0.2, 0.6, 30.0, 30.6].map { Double(Float($0)) })
        try validateSegments(words, duration: 40)
    }

    func testWordsAreClampedToTheAudioAndNeverRunBackwards() throws {
        let segment = TranscriptionSegment(start: 9, end: 10.2, text: " the end", words: [word(" the", 9.5, 9.4), word(" end", 9.9, 10.2), word(" early", -0.1, 0.3)])
        let words = try WhisperKitTranscription.timedWords([segment], duration: 10)
        XCTAssertEqual(words.map(\.text), ["early", "the", "end"])
        XCTAssertEqual(words[0].start, 0)
        XCTAssertEqual(words[1].end, words[1].start, "an end before its start becomes a zero-length word")
        XCTAssertEqual(words[2].end, 10)
        try validateSegments(words, duration: 10)
    }

    func testTextWithoutWordTimingIsAnErrorButSilenceIsNot() throws {
        XCTAssertEqual(try WhisperKitTranscription.timedWords([TranscriptionSegment(start: 0, end: 5, text: "  ", words: nil)], duration: 5).count, 0)
        XCTAssertEqual(try WhisperKitTranscription.timedWords([], duration: 5).count, 0)
        XCTAssertThrowsError(try WhisperKitTranscription.timedWords([TranscriptionSegment(start: 0, end: 5, text: " spoken words", words: nil)], duration: 5))
        XCTAssertThrowsError(try WhisperKitTranscription.timedWords([TranscriptionSegment(start: 0, end: 5, text: " spoken words", words: [])], duration: 5))
        XCTAssertThrowsError(try WhisperKitTranscription.timedWords(
            [TranscriptionSegment(start: 0, end: 5, text: " bad", words: [word(" bad", .nan, 1)])], duration: 5))
    }

    func testAMissingModelIsASetupMessageNotADownload() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        func request(_ modelFolder: String?) throws -> Request {
            let body: [String: Any?] = ["version": 1, "id": "t", "operation": "transcribe", "modelFolder": modelFolder, "engine": "whisperkit"]
            return try JSONDecoder().decode(Request.self, from: JSONSerialization.data(withJSONObject: body.compactMapValues { $0 }))
        }
        XCTAssertThrowsError(try WhisperKitTranscription.modelFolder(request(nil)))
        XCTAssertThrowsError(try WhisperKitTranscription.modelFolder(request("relative/folder")))
        XCTAssertThrowsError(try WhisperKitTranscription.modelFolder(request(folder.path))) { error in
            XCTAssertTrue(error.localizedDescription.contains("no download was started"))
        }
        for name in WhisperKitTranscription.requiredFiles {
            FileManager.default.createFile(atPath: folder.appendingPathComponent(name).path, contents: Data())
        }
        XCTAssertEqual(try WhisperKitTranscription.modelFolder(request(folder.path)).path, folder.path)
    }

    func testRequestsWithoutTheNewFieldsStillDecode() throws {
        let old = try JSONDecoder().decode(Request.self, from: Data(#"{"version":1,"id":"a","operation":"transcribe","audioPath":"/a.m4a","locale":"en-US"}"#.utf8))
        XCTAssertNil(old.engine)
        XCTAssertNil(old.contextualStrings)
        let new = try JSONDecoder().decode(Request.self, from: Data(#"{"version":1,"id":"a","operation":"transcribe","engine":"whisperkit","contextualStrings":["SLSA"]}"#.utf8))
        XCTAssertEqual(new.engine, "whisperkit")
        XCTAssertEqual(new.contextualStrings ?? [], ["SLSA"])
    }
}
