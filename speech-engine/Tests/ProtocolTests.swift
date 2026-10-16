import XCTest
@testable import MeetingNotesSpeech

final class ProtocolTests: XCTestCase {
    func testInvalidVectorsDoNotEnroll() {
        XCTAssertFalse(usableVector([]))
        XCTAssertFalse(usableVector([0, 0]))
        XCTAssertFalse(usableVector([.nan, 1]))
        XCTAssertFalse(usableVector([.infinity]))
        XCTAssertTrue(usableVector([0, 1]))
    }
    func testTimestampValidation() throws {
        try validateSegments([TimedText(start: 0, end: 2, text: "hello")], duration: 2)
        XCTAssertThrowsError(try validateSegments([TimedText(start: -1, end: 2, text: "bad")], duration: 2))
        XCTAssertThrowsError(try validateSegments([TimedText(start: 0, end: .nan, text: "bad")], duration: 2))
        XCTAssertThrowsError(try validateSegments([TimedText(start: 2, end: 5, text: "bad")], duration: 2))
    }
}
