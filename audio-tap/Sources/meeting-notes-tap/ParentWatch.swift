import Foundation
import Darwin

// Posix-style PID watchdog. When the parent process exits, the kqueue
// event fires; we stop and exit. Used so an Electron crash doesn't leave
// an orphan recorder running indefinitely.
enum ParentWatch {
  static func onParentExit(_ handler: @escaping () -> Void) {
    let parentPID = getppid()
    DispatchQueue.global().async {
      let kq = kqueue()
      guard kq >= 0 else { return }
      var event = kevent(
        ident: UInt(parentPID),
        filter: Int16(EVFILT_PROC),
        flags: UInt16(EV_ADD | EV_ENABLE | EV_ONESHOT),
        fflags: UInt32(NOTE_EXIT),
        data: 0, udata: nil
      )
      guard kevent(kq, &event, 1, nil, 0, nil) >= 0 else { close(kq); return }
      var triggered = kevent()
      let n = kevent(kq, nil, 0, &triggered, 1, nil)
      close(kq)
      if n > 0 { handler() }
    }
  }
}
