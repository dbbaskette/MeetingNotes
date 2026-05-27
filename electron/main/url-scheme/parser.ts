// electron/main/url-scheme/parser.ts
//
// Parse meetingnotes:// URLs into a tagged union the dispatcher can switch on.
// All input is treated as untrusted — the URL can originate from any process
// on the user's Mac that knows the scheme exists, so we validate the verb,
// the query keys, and the value shapes before handing anything to the
// dispatcher. (Same trust model as a manual Record click — see issue #77.)

import { z } from 'zod';

const SourceSchema = z.string()
  .trim()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, 'source must be alphanumeric / . _ -')
  .optional();

const TitleSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .optional();

// Meeting IDs from `meetings-repo` are short random alphanumeric strings.
// Cap length to defang a runaway query value reaching the SQLite layer.
const MeetingIdSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid meeting id');

export interface RecordCommand {
  kind: 'record';
  source: string;
  title: string | null;
}

export interface StopCommand {
  kind: 'stop';
}

export interface OpenCommand {
  kind: 'open';
  meetingId: string;
}

export type SchemeCommand = RecordCommand | StopCommand | OpenCommand;

export interface ParseError {
  kind: 'error';
  reason: string;
}

export type ParseResult = SchemeCommand | ParseError;

/** Parse a meetingnotes:// URL. Returns a discriminated union — never
 *  throws. The dispatcher converts ParseError into a user-visible
 *  notification + log entry. */
export function parseSchemeUrl(input: string): ParseResult {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { kind: 'error', reason: 'invalid URL' };
  }
  if (parsed.protocol !== 'meetingnotes:') {
    return { kind: 'error', reason: `unsupported protocol: ${parsed.protocol}` };
  }
  // URL parses `meetingnotes://record?x=y` as host='record', pathname=''.
  // It parses `meetingnotes:record?x=y` (no slashes) as host='', pathname='record'.
  // Accept both — Shortcuts and `open(1)` differ in how they emit the slashes.
  const verb = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  switch (verb) {
    case 'record': {
      const sourceResult = SourceSchema.safeParse(parsed.searchParams.get('source') ?? undefined);
      if (!sourceResult.success) {
        return { kind: 'error', reason: `invalid source: ${sourceResult.error.errors[0]?.message ?? 'malformed'}` };
      }
      const titleResult = TitleSchema.safeParse(parsed.searchParams.get('title') ?? undefined);
      if (!titleResult.success) {
        return { kind: 'error', reason: `invalid title: ${titleResult.error.errors[0]?.message ?? 'malformed'}` };
      }
      return {
        kind: 'record',
        source: sourceResult.data ?? 'all',
        title: titleResult.data ?? null,
      };
    }
    case 'stop':
      return { kind: 'stop' };
    case 'open': {
      const idResult = MeetingIdSchema.safeParse(parsed.searchParams.get('id') ?? undefined);
      if (!idResult.success) {
        return { kind: 'error', reason: `invalid id: ${idResult.error.errors[0]?.message ?? 'missing'}` };
      }
      return { kind: 'open', meetingId: idResult.data };
    }
    default:
      return { kind: 'error', reason: `unknown verb: ${verb || '(empty)'}` };
  }
}

// Keyword → bundle id map for the `source=` query value. Matches the
// MEETING_APP_BUNDLE_IDS set in audio-tap/Sources/.../ProcessList.swift —
// keep these in sync.
export const SOURCE_KEYWORD_TO_BUNDLE_IDS: Record<string, string[]> = {
  zoom: ['us.zoom.xos'],
  teams: ['com.microsoft.teams2', 'com.microsoft.teams'],
  facetime: ['com.apple.FaceTime'],
  slack: ['com.tinyspeck.slackmacgap'],
  discord: ['com.hnc.Discord'],
  whatsapp: ['WhatsApp', 'net.whatsapp.WhatsApp'],
};

/** True iff a string looks like a reverse-DNS bundle id (contains a dot
 *  and at least one non-digit segment). Used to branch resolveSource()
 *  between bundle-lookup and keyword-lookup paths. */
export function looksLikeBundleId(s: string): boolean {
  return s.includes('.') && /[a-zA-Z]/.test(s);
}
