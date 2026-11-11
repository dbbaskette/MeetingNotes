import Foundation
#if SWIFT_PACKAGE
@testable import meeting_notes_tap
#endif

enum TapWatchdogSmoke {
  private static func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw AACWriterSmoke.Failure(message: message) }
  }

  static func stallAndRecoveryTests() throws {
    // Healthy capture: the callback count rises every tick, nothing happens.
    var healthy = TapWatchdog()
    for fires in stride(from: UInt64(100), through: 1000, by: 100) {
      try require(healthy.tick(fires: fires) == .none, "A running tap is left alone")
    }

    // The 11 Nov failure: one early callback, then the Bluetooth profile
    // change stops the tap for good. Restart on the first silent tick.
    var stalled = TapWatchdog()
    try require(stalled.tick(fires: 3) == .none, "First callbacks count as running")
    try require(stalled.tick(fires: 3) == .restart(attempt: 1, stalledTicks: 1), "A tick without callbacks restarts the tap")
    try require(stalled.tick(fires: 250) == .recovered(attempts: 1, stalledTicks: 1), "Callbacks after a restart report recovery once")
    try require(stalled.tick(fires: 350) == .none, "Recovery is reported once")

    // A tap that never delivers anything is restarted too.
    var dead = TapWatchdog()
    try require(dead.tick(fires: 0) == .restart(attempt: 1, stalledTicks: 1), "A tap with no callbacks at all restarts")

    // Devices can stay unsettled for seconds. Retry every tick five times,
    // then every fifth tick, and never give up while the recording runs.
    var flaky = TapWatchdog()
    var restarts: [Int] = []
    for tick in 1...30 {
      if case .restart(let attempt, let stalledTicks) = flaky.tick(fires: 0) {
        try require(stalledTicks == tick, "Stall length counts every silent tick")
        try require(attempt == restarts.count + 1, "Attempts are numbered in order")
        restarts.append(tick)
      }
    }
    try require(restarts == [1, 2, 3, 4, 5, 10, 15, 20, 25, 30], "Five quick retries, then one every five ticks: \(restarts)")
    try require(flaky.tick(fires: 40) == .recovered(attempts: 10, stalledTicks: 30), "A late recovery reports the whole outage")

    // A second outage after a recovery starts counting again.
    try require(flaky.tick(fires: 40) == .restart(attempt: 1, stalledTicks: 1), "A later stall restarts immediately")
  }
}
