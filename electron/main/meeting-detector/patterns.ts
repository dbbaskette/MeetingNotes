// electron/main/meeting-detector/patterns.ts
//
// URL patterns for well-known web meeting platforms. Ported from
// simple-meeting-scribe's Resources/meeting-patterns.json. Ordering
// matters: the first match wins, so more specific hosts come first.

export interface MeetingPattern {
  platform: string;
  // Matched against the full URL. Case-insensitive.
  regex: RegExp;
}

export const MEETING_PATTERNS: MeetingPattern[] = [
  { platform: 'Google Meet', regex: /https?:\/\/meet\.google\.com\/[a-z0-9-]+/i },
  { platform: 'Zoom', regex: /https?:\/\/([a-z0-9-]+\.)?zoom\.us\/(j|wc|my|s)\/\d+/i },
  { platform: 'Microsoft Teams', regex: /https?:\/\/teams\.(microsoft|live)\.com\/.*\/meetup-join/i },
  { platform: 'Microsoft Teams', regex: /https?:\/\/teams\.(microsoft|live)\.com\/_#\/l\/meetup-join/i },
  { platform: 'Whereby', regex: /https?:\/\/whereby\.com\/[a-z0-9-]+/i },
  { platform: 'Jitsi Meet', regex: /https?:\/\/meet\.jit\.si\/[a-zA-Z0-9-]+/i },
  { platform: 'Gather', regex: /https?:\/\/(app\.)?gather\.town\/(app|i)\//i },
  { platform: 'Around', regex: /https?:\/\/meet\.around\.co\/[a-z0-9-]+/i },
  { platform: 'Discord', regex: /https?:\/\/discord\.com\/channels\/.+/i },
  { platform: 'Slack Huddle', regex: /https?:\/\/app\.slack\.com\/huddle\//i },
  { platform: 'Webex', regex: /https?:\/\/([a-z0-9-]+\.)?webex\.com\/(meet|wbxmjs|wseqlm|join)\//i },
  { platform: 'BlueJeans', regex: /https?:\/\/bluejeans\.com\/\d+/i },
  { platform: 'GoToMeeting', regex: /https?:\/\/(app\.)?gotomeeting\.com\/(join|start)\//i },
];

export function matchMeeting(url: string): string | null {
  for (const p of MEETING_PATTERNS) {
    if (p.regex.test(url)) return p.platform;
  }
  return null;
}
