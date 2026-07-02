// electron/renderer/src/lib/awaiting-gate.ts
//
// Pure derivation for the Library's app-wide "needs you to name voices" badge.
// A meeting parked at the speaker-ID gate carries status='awaiting_user'; the
// badge counts those and points at the first one so the user can jump straight
// in. Kept as a pure function so it's unit-testable without rendering the whole
// LibraryView (the repo has no DOM test env — component wiring is verified
// manually, mirroring the native-Notification shell in the same feature).

interface AwaitingLike {
  id: string;
  status: string;
}

/** The meetings blocked on the user at the speaker-ID gate, in input order. */
export function awaitingGateMeetings<T extends AwaitingLike>(meetings: T[]): T[] {
  return meetings.filter((m) => m.status === 'awaiting_user');
}
