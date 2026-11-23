import EventKit
import Foundation

// Read-only calendar access for calendar-aware recording (#253). Runs inside
// the capture helper so macOS attributes the Calendars permission to
// MeetingNotes. Three subcommands, each printing one JSON object on stdout:
//
//   calendar status                       never prompts
//   calendar request                      the only path that may prompt
//   calendar events --from ISO --to ISO   fails cleanly without full access
//
// Nothing is written to any calendar and no attendee e-mail address is
// printed: only display names.

enum CalendarSubcommand {
  case status
  case request
  case events(from: Date, to: Date)
}

enum CalendarTool {
  static func parse(_ args: [String]) -> CalendarSubcommand {
    guard let sub = args.first else { fail("usage", "calendar status | request | events --from <ISO8601> --to <ISO8601>") }
    switch sub {
    case "status": return .status
    case "request": return .request
    case "events":
      var from: Date?
      var to: Date?
      var i = 1
      while i < args.count {
        switch args[i] {
        case "--from":
          i += 1
          guard i < args.count, let d = parseDate(args[i]) else { fail("usage", "--from requires an ISO 8601 date") }
          from = d
        case "--to":
          i += 1
          guard i < args.count, let d = parseDate(args[i]) else { fail("usage", "--to requires an ISO 8601 date") }
          to = d
        default:
          fail("usage", "unknown flag: \(args[i])")
        }
        i += 1
      }
      guard let f = from, let t = to, f <= t else { fail("usage", "--from and --to are required, with --from not after --to") }
      return .events(from: f, to: t)
    default:
      fail("usage", "unknown calendar subcommand: \(sub)")
    }
  }

  static func run(_ cmd: CalendarSubcommand) -> Never {
    switch cmd {
    case .status:
      emit(["status": statusName(EKEventStore.authorizationStatus(for: .event))])
      exit(0)
    case .request:
      let store = EKEventStore()
      let done = DispatchSemaphore(value: 0)
      store.requestFullAccessToEvents { _, _ in done.signal() }
      done.wait()
      emit(["status": statusName(EKEventStore.authorizationStatus(for: .event))])
      exit(0)
    case .events(let from, let to):
      let status = EKEventStore.authorizationStatus(for: .event)
      // Never prompt from here: without full access, say so and stop.
      guard status == .fullAccess else {
        emit(["error": "no-access", "status": statusName(status)])
        exit(3)
      }
      let store = EKEventStore()
      let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
      let events = store.events(matching: predicate).map(describe)
      emit(["events": events])
      exit(0)
    }
  }

  static func statusName(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: return "denied"
    }
  }

  private static func describe(_ event: EKEvent) -> [String: Any] {
    let people = (event.attendees ?? []).filter { $0.participantType != .room && $0.participantType != .resource }
    var names: [String] = []
    for person in people {
      // Display names only. A name that is really an address is dropped.
      guard let name = person.name?.trimmingCharacters(in: .whitespacesAndNewlines),
            !name.isEmpty, !name.contains("@"), !names.contains(name) else { continue }
      names.append(name)
    }
    let me = people.first { $0.isCurrentUser }
    var out: [String: Any] = [
      "title": event.title ?? "",
      "start": iso(event.startDate),
      "end": iso(event.endDate),
      "attendees": names,
      "allDay": event.isAllDay,
      "declined": me?.participantStatus == .declined,
    ]
    // Occurrences of one recurring series share the external identifier.
    if event.hasRecurrenceRules, let series = event.calendarItemExternalIdentifier, !series.isEmpty {
      out["seriesId"] = series
    } else {
      out["seriesId"] = NSNull()
    }
    return out
  }

  private static func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: date)
  }

  static func parseDate(_ value: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: value) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: value)
  }

  private static func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
  }

  private static func fail(_ code: String, _ message: String) -> Never {
    emit(["error": code, "message": message])
    exit(2)
  }
}
