// electron/main/exporters/owner-filter.ts
//
// Shared "is this action item mine?" logic for the task-app exporters
// (Apple Reminders, Google Tasks). Those push items into the user's
// personal to-do list, so we only ever send items assigned to *them* — not
// the whole meeting's action items. Document exporters (Markdown, Google
// Doc) are full records and don't use this.
//
// An item's owner can be a roster speaker (owner_speaker_id) OR free text
// the user typed (owner_name). We match on either so "mine" works whether
// Extract linked the roster entry or the user just typed their own name.

/** The exporter ids that should be restricted to the user's own items. */
export const TASK_APP_EXPORTERS: ReadonlySet<string> = new Set([
  'reminders',
  'google-tasks',
]);

export interface OwnerIdentity {
  /** settings.userSpeakerId — the roster id the user picked as "You are…". */
  userSpeakerId: string | null;
  /** Display name of that roster entry, for matching free-text owners. */
  userDisplayName: string | null;
}

export interface OwnedItem {
  ownerSpeakerId: string | null;
  ownerName: string | null;
}

/** True when the action item is owned by the user — by roster id, or by a
 *  free-text owner name that matches the user's display name (trim +
 *  case-insensitive). Returns false when the user hasn't identified
 *  themselves (no userSpeakerId and no userDisplayName). */
export function isMyItem(item: OwnedItem, me: OwnerIdentity): boolean {
  if (me.userSpeakerId && item.ownerSpeakerId === me.userSpeakerId) return true;
  if (
    me.userDisplayName &&
    item.ownerName &&
    item.ownerName.trim().toLowerCase() === me.userDisplayName.trim().toLowerCase()
  ) {
    return true;
  }
  return false;
}

/** True when the user has told us who they are — required for the
 *  task-app "only mine" filter to mean anything. */
export function userIsIdentified(me: OwnerIdentity): boolean {
  return Boolean(me.userSpeakerId);
}
