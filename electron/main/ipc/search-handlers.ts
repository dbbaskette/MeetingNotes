import type { IpcMain } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { IPC_CHANNELS, OptionalGroupScopeSchema } from './contracts.js';
import type { IpcServices } from './handlers.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { ripgrepSearch, ripgrepSearchDetailed } from '../search/ripgrep-search.js';
import { FacetsSchema, searchScope } from '../search/facets.js';
import { SearchOwners } from '../search/owners.js';

function createSearchState() {
  const searchOwners = new SearchOwners();
  const SearchOwnerSchema = z.object({ clientId:z.string().min(1).max(100), requestId:z.number().int().nonnegative() });
  const SearchRequestSchema = SearchOwnerSchema.extend({facets:FacetsSchema.optional()}).strict();
  const observedSearchSenders = new WeakSet<object>();
  return { searchOwners, SearchOwnerSchema, SearchRequestSchema, observedSearchSenders };
}

/** Per-registration search state shared by search:cancel and search:query
 *  (one SearchOwners instance per registerIpcHandlers call). */
export type SearchState = ReturnType<typeof createSearchState>;

export function registerSearchCancelHandler(ipc: IpcMain): SearchState {
  const state = createSearchState();
  const { searchOwners, SearchOwnerSchema } = state;
  ipc.handle(IPC_CHANNELS.searchCancel,(event,input:unknown)=>{
    const request=SearchOwnerSchema.parse(input);searchOwners.cancel(event.sender.id,request.clientId,request.requestId);
  });
  return state;
}

export function registerSearchQueryHandler(ipc: IpcMain, s: IpcServices, state: SearchState): void {
  const { searchOwners, SearchRequestSchema, observedSearchSenders } = state;
  // Cmd+K global search (#45). Titles are matched in-memory off the DB;
  // summary/transcript content is searched via the bundled ripgrep
  // binary (@vscode/ripgrep) over the library's meetings/ tree. rg
  // parallelizes the walk and matches with SIMD, so even a multi-
  // thousand-meeting library answers each keystroke in tens of ms.
  ipc.handle(IPC_CHANNELS.searchQuery, async (_e, query: unknown, limit: unknown, scopeInput: unknown, requestInput?: unknown) => {
    const request = requestInput === undefined ? null : SearchRequestSchema.parse(requestInput);
    if(request && !observedSearchSenders.has(_e.sender)) {
      observedSearchSenders.add(_e.sender);
      _e.sender.once('destroyed',()=>searchOwners.destroy(_e.sender.id));
    }
    const owner = request ? await searchOwners.begin(_e.sender.id,request.clientId,request.requestId) : null;
    try {
    if(owner?.signal.aborted) return {hits:[],status:'cancelled'};
    if (typeof query !== 'string') {if(request)throw new Error('Search query must be text');return [];}
    const groupId = OptionalGroupScopeSchema.parse(scopeInput);
    const q = query.trim().slice(0,500);
    if(request?.facets?.content&&q.length<2)return{hits:[],status:'partial',message:'Enter at least two characters to search notes or transcripts.'};
    if (q.length < 2 && !request) return [];
    const qLower = q.toLowerCase();
    const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 20;

    interface Hit {
      meetingId: string;
      title: string;
      groupName: string | null;
      source: 'title' | 'summary' | 'transcript';
      snippet: string;
      seconds?: number;
      score: number;
    }
    const hits: Hit[] = [];
    const facets = request?.facets ?? {};
    const meId = s.settings.get('userSpeakerId');
    const scope = request ? searchScope(facets,groupId,{id:meId,name:meId?s.speakers.findById(meId)?.displayName??null:s.settings.get('userName')??null}) : null;
    const faceted = request ? s.meetings.facetedSearch() : null;

    // Title hits — rank highest so an exact-title match surfaces first.
    // Pushed down to SQL (LIKE, parameter-bound) instead of scanning a
    // listAll() snapshot per keystroke. Newest-first, capped at `max` —
    // the final slice keeps at most `max` anyway and titles outrank
    // everything else.
    for (const m of facets.content ? [] : faceted && scope ? faceted.titles(q,max+1,scope).map(row=>({...row,groupName:row.groupName})) : s.meetings.searchByTitle(q, max, groupId)) {
      hits.push({
        meetingId: m.id, title: m.title, groupName: m.groupName, source: 'title',
        snippet: m.title, score: 1000,
      });
    }

    // Content hits — one rg invocation across both file types. We pass
    // --max-count 3 so transcript files cap cleanly; for summaries we
    // additionally take only the first match below (one hit per
    // meeting is plenty, since a summary is short).
    const meetingsRoot = path.join(s.libraryRoot, 'meetings');
    const eligibleSlugs = new Set(faceted && scope ? faceted.slugs(scope) : []);
    // Narrow rg's input paths only for small filtered subsets (<= 128 folders)
    // so unfiltered or broad searches run a single rg process over meetingsRoot
    // instead of spawning sequential 128-folder batches (or calling sync lstat
    // over every meeting folder on the main thread). rg runs with --no-messages
    // and safely skips missing directories.
    const scopedPaths =
      eligibleSlugs.size === 0
        ? []
        : eligibleSlugs.size <= 128
          ? [...eligibleSlugs]
              .map((slug) => meetingFolderPath(s.libraryRoot, slug))
              .filter((folder) => path.dirname(folder) === meetingsRoot)
          : undefined;
    const detailed = request ? await ripgrepSearchDetailed(meetingsRoot, q, {
      ...(scopedPaths !== undefined ? { paths: scopedPaths } : {}),
      maxCountPerFile: 3, maxTotalMatches: 10000, signal: owner!.signal,
      globs: facets.content ? [`${facets.content}.md`] : ['summary.md', 'transcript.md'],
      acceptFile: (file) => {
        const parts = path.relative(meetingsRoot, file).split(path.sep);
        if (parts.length !== 2 || parts[0] === '..') return false;
        const slug = parts[0]!;
        return eligibleSlugs.has(slug);
      },
    }) : null;
    const rgHits = detailed?.matches ?? await ripgrepSearch(meetingsRoot,q,{maxCountPerFile:3,globs:['summary.md','transcript.md']});

    // Resolve only the slugs rg actually hit — one chunked IN query
    // instead of materializing the entire library.
    const slugFor = (file: string): string | null => {
      // Path shape: {libraryRoot}/meetings/{slug}/(summary|transcript).md
      const segs = path.relative(meetingsRoot, file).split(path.sep);
      return segs.length === 2 ? segs[0]! : null;
    };
    const hitSlugs = [...new Set(
      rgHits.map((r) => slugFor(r.file)).filter((sl): sl is string => sl !== null),
    )];
    const bySlug = new Map(s.meetings.findBySlugs(hitSlugs, groupId).map((m) => [m.slug, m]));

    const summarySeen = new Set<string>(); // slug — caps summary hits at 1/meeting
    for (const r of rgHits) {
      const rel = path.relative(meetingsRoot, r.file);
      const segs = rel.split(path.sep);
      if (segs.length !== 2) continue;
      const [slug, basename] = segs;
      const meeting = bySlug.get(slug!);
      if (!meeting) continue;

      if (basename === 'summary.md') {
        if (summarySeen.has(slug!)) continue;
        summarySeen.add(slug!);
        hits.push({
          meetingId: meeting.id,
          title: meeting.title,
          groupName: meeting.groupName,
          source: 'summary',
          snippet: trimSnippet(r.lineText, qLower, 120),
          score: 500,
        });
      } else if (basename === 'transcript.md') {
        const seconds = parseTimestampSeconds(r.lineText);
        const speakerLabel = parseSpeakerLabel(r.lineText);
        hits.push({
          meetingId: meeting.id,
          title: meeting.title,
          groupName: meeting.groupName,
          source: 'transcript',
          snippet: speakerLabel
            ? `${speakerLabel}: ${stripTimestampPrefix(r.lineText)}`.slice(0, 200)
            : r.lineText.trim().slice(0, 160),
          ...(seconds !== undefined ? { seconds } : {}),
          score: 100,
        });
      }
    }

    // Sort by score; ties resolve in rg's discovery order (which is
    // already filesystem-driven, not date-sorted — close enough for a
    // palette where the score gap between tiers dominates).
    hits.sort((a, b) => b.score - a.score);
    const results = hits.slice(0, max).map((h) => ({
      meetingId: h.meetingId, title: h.title, groupName: h.groupName, source: h.source,
      snippet: h.snippet,
      ...(h.seconds !== undefined ? { seconds: h.seconds } : {}),
    }));
    return request ? {hits:owner!.signal.aborted?[]:results,status:owner!.signal.aborted?'cancelled':detailed!.status==='complete'&&hits.length>max?'limit':detailed!.status,message:detailed!.message??(hits.length>max?'Result limit reached; refine the query or filters.':undefined)} : results;
    } finally { owner?.finish(); }
  });
}

// Trim a ripgrep-matched line down to a ~window-char snippet centered on
// the match, with ellipses on either side when truncated. Used for
// summary hits, where the matched line can be a whole paragraph.
function trimSnippet(line: string, qLower: string, window: number): string {
  const text = line.replace(/\s+/g, ' ').trim();
  if (text.length <= window) return text;
  const idx = text.toLowerCase().indexOf(qLower);
  if (idx < 0) return text.slice(0, window) + '…';
  const start = Math.max(0, idx - Math.floor(window / 2));
  const end = Math.min(text.length, start + window);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// Transcript lines begin with "[Speaker MM:SS]" or "[Speaker HH:MM:SS]"
// (see pipeline/stages/merging.ts). Extract the seconds offset so
// Cmd+Enter can seek the audio to the matched line. Returns undefined
// for lines without a parseable prefix (e.g. an opening header line).
const TIMESTAMP_LINE = /^\[(.+?)\s+(?:(\d+):)?(\d+):(\d{2})\]\s?(.*)$/;

function parseTimestampSeconds(line: string): number | undefined {
  const m = line.match(TIMESTAMP_LINE);
  if (!m) return undefined;
  const hh = m[2] ? parseInt(m[2], 10) : 0;
  return hh * 3600 + parseInt(m[3]!, 10) * 60 + parseInt(m[4]!, 10);
}

function parseSpeakerLabel(line: string): string | undefined {
  const m = line.match(TIMESTAMP_LINE);
  return m ? m[1] : undefined;
}

function stripTimestampPrefix(line: string): string {
  const m = line.match(TIMESTAMP_LINE);
  return (m ? (m[5] ?? '') : line).trim();
}
