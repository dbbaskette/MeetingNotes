import Foundation

/// Decides when the app-audio tap has stopped delivering and must be rebuilt.
///
/// The tap's callback fires about every 10 ms for as long as its output
/// device runs, whether or not the tapped app is making sound. A whole tick
/// (one second) without a callback therefore means the device stopped. This
/// happens when a Bluetooth headset changes profile under the tap: macOS
/// pauses the tap's IO for the reconfiguration and the resume can fail,
/// after which nothing restarts it.
struct TapWatchdog {
  enum Action: Equatable {
    case none
    /// Tear the tap down and build a new one.
    case restart(attempt: Int, stalledTicks: Int)
    /// Callbacks are flowing again after `attempts` restarts.
    case recovered(attempts: Int, stalledTicks: Int)
  }

  /// Restart on each of the first silent ticks, then less often: a device
  /// that is gone for minutes should not be rebuilt every second.
  static let quickAttempts = 5
  static let slowRetryTicks = 5

  private var lastFires: UInt64?
  private var stalledTicks = 0
  private var attempts = 0
  private var ticksUntilRetry = 0

  /// Call once per tick with the running total of tap callbacks.
  mutating func tick(fires: UInt64) -> Action {
    let previous = lastFires ?? 0
    lastFires = fires
    if fires != previous {
      let outcome: Action = attempts > 0 ? .recovered(attempts: attempts, stalledTicks: stalledTicks) : .none
      stalledTicks = 0; attempts = 0; ticksUntilRetry = 0
      return outcome
    }
    stalledTicks += 1
    if ticksUntilRetry > 0 {
      ticksUntilRetry -= 1
      if ticksUntilRetry > 0 { return .none }
    }
    attempts += 1
    ticksUntilRetry = attempts >= Self.quickAttempts ? Self.slowRetryTicks : 0
    return .restart(attempt: attempts, stalledTicks: stalledTicks)
  }
}
