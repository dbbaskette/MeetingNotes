// Scoping and disclosure for "Ask your meetings" (#254): which meetings a
// filtered library question may draw on (the same facet rules ⌘K search
// applies, from search/facets.ts), how to name that scope, and where the
// answering model runs.
import type { SearchFacets } from '../../shared/search.js';
import type { AskEndpoint } from '../../shared/ask.js';
import { effectiveLlmUrl, type LLMProvider } from '../../shared/inference-endpoints.js';
import { searchScope, type FacetedMeetings } from '../search/facets.js';

/** True when the facets narrow which meetings count. `content` only picks
 *  notes or transcripts and leaves every meeting in. */
export function facetsNarrowMeetings(facets: SearchFacets): boolean {
  return Object.entries(facets).some(([key, value]) => key !== 'content' && value !== undefined && value !== false);
}

/** Ids of the meetings the search facets allow, using search's own SQL
 *  scope (dates, week, speaker, status, tasks, source, warnings; deleted
 *  meetings never). Undefined when the facets do not narrow meetings. */
export function facetCandidates(
  facets: SearchFacets,
  meetings: readonly { id: string; slug: string }[],
  faceted: Pick<FacetedMeetings, 'slugs'>,
  me: { id: string | null; name: string | null },
): string[] | undefined {
  if (!facetsNarrowMeetings(facets)) return undefined;
  const eligible = new Set(faceted.slugs(searchScope(facets, undefined, me)));
  return meetings.filter((meeting) => eligible.has(meeting.slug)).map((meeting) => meeting.id);
}

const STATUS_WORDS: Record<NonNullable<SearchFacets['status']>, string> = {
  pending: 'not yet processed', processing: 'still processing', awaiting_user: 'waiting for you',
  done: 'processed', failed: 'that failed',
};

/** "Asked across 12 meetings in week 2026-W46, with Alice, processed".
 *  Null when no filter is active. */
export function describeAskScope(facets: SearchFacets, count: number, speakerName: string | null): string | null {
  const parts: string[] = [];
  if (facets.week) parts.push(`in week ${facets.week}`);
  if (facets.from && facets.to) parts.push(`from ${facets.from} through ${facets.to}`);
  else if (facets.from) parts.push(`since ${facets.from}`);
  else if (facets.to) parts.push(`through ${facets.to}`);
  if (facets.speakerId) parts.push(`with ${speakerName ?? 'the chosen speaker'}`);
  if (facets.status) parts.push(STATUS_WORDS[facets.status]);
  if (facets.actions) parts.push(facets.actions === 'mine' ? 'with open tasks for you' : 'with open tasks');
  if (facets.source) parts.push(facets.source === 'import' ? 'imported' : 'recorded in the app');
  if (facets.warning) parts.push('with recording warnings');
  if (facets.content) parts.push(facets.content === 'summary' ? 'notes only' : 'transcripts only');
  if (!parts.length) return null;
  return `Asked across ${count} ${count === 1 ? 'meeting' : 'meetings'} ${parts.join(', ')}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Where the answering model runs, from the summary-model settings. The
 *  managed runtimes always listen on this Mac; an external URL counts as
 *  local only when its host is a loopback name. Only the host (and port)
 *  is returned: never credentials, path or query. */
export function askEndpoint(provider: LLMProvider, externalUrl: string): AskEndpoint {
  if (provider !== 'external') return { local: true };
  let url: URL;
  try { url = new URL(effectiveLlmUrl(provider, externalUrl)); } catch { return { local: false, host: 'the endpoint set in Settings' }; }
  if (LOOPBACK.has(url.hostname.toLowerCase())) return { local: true };
  return { local: false, host: url.host || 'the endpoint set in Settings' };
}
