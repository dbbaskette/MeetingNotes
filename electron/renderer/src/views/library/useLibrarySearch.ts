// electron/renderer/src/views/library/useLibrarySearch.ts
//
// Inline full-content search for the Library, moved out of LibraryView.tsx
// unchanged (#256). Called at the same position in the view, so hook order,
// effect order and dependency arrays are as before.
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { SearchHit } from '../../components/SearchMatches';
import { api } from '../../ipc/client';
import { hydrateLibrarySearch, startLibrarySearchHydration } from '../../lib/library-search';
import { recycleMeetings } from '../../lib/meetings-recycle';
import type { SearchFacets } from '../../../../shared/search';
import type { MeetingSummary } from '../../lib/paged-meetings';
import type { LibFilter } from './types';

export function useLibrarySearch({
  query, facets, groupId, libFilter, searchRevision, active, hasMotion,
  searchClientId, searchRequestId, setSearchCompletion,
}: {
  query: string;
  facets: SearchFacets;
  groupId: string | null | undefined;
  libFilter: LibFilter;
  searchRevision: number;
  active: boolean;
  hasMotion: boolean;
  /** Owned by the view (declared before this hook); stable refs and setter. */
  searchClientId: MutableRefObject<string>;
  searchRequestId: MutableRefObject<number>;
  setSearchCompletion: Dispatch<SetStateAction<string | null>>;
}) {
  // Full-content search. At 2+ chars we hit the same global IPC the
  // Cmd+K palette uses, which ripgreps summary.md + transcript.md across
  // the library. Debounced so a fast typist doesn't fire one IPC per
  // keystroke.
  const isSearching = query.trim().length >= 2 || Object.keys(facets).length > 0;
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchMeetings, setSearchMeetings] = useState<MeetingSummary[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const previousSearchQuery = useRef('');
  useEffect(() => {
    const searchKey = `${groupId ?? (groupId === null ? 'ungrouped' : 'all')}:${query.trim()}`;
    if (!isSearching || previousSearchQuery.current !== searchKey) {
      setHits([]);
      setSearchMeetings([]);
    }
    previousSearchQuery.current = searchKey;
    setSearchError(null);
    if (!isSearching) { setSearchPending(false); return; }
    let cancelled = false, dispatched=false;
    const requestId=++searchRequestId.current;
    setSearchCompletion(null);
    setSearchPending(true);
    const t = window.setTimeout(async () => {
      try {
        dispatched=true;
        const response=await api.search.run(query,100,groupId,{clientId:searchClientId.current,requestId,facets:{...facets,...!facets.status&&libFilter!=='all'?{status:libFilter}:{}}});
        if(response.status==='failed')throw new Error(response.message??'Search failed');
        const result = await hydrateLibrarySearch(query, { query: async()=>response.hits, getMany: api.meetings.getMany }, groupId);
        if(!cancelled)setSearchCompletion(response.status==='complete'?null:response.message??response.status);
        if (!cancelled) {
          setHits(result.hits);
          setSearchMeetings(result.meetings);
        }
      } catch (error) {
        if (!cancelled) setSearchError(error instanceof Error ? error.message : 'Unable to search meetings.');
      } finally {
        if (!cancelled) setSearchPending(false);
      }
    }, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref is a request counter; cleanup must read its latest value
    return () => { cancelled = true; window.clearTimeout(t); if(dispatched)void api.search.cancel(searchClientId.current,requestId); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- searchClientId/searchRequestId are refs and setSearchCompletion a state setter, all stable; the list is unchanged from LibraryView
  }, [query, isSearching, searchRevision, groupId, facets,libFilter]);

  // Browse polling cannot update these detached, globally hydrated rows.
  // Hold a summary-only poll on the same active cadence, including off-page
  // hits; suspend it while a replacement search result is being hydrated.
  useEffect(() => {
    if (!active || !isSearching || !hasMotion || searchPending || hits.length === 0) return;
    return startLibrarySearchHydration(hits, api.meetings.getMany, (rows) => {
      setSearchMeetings((previous) => recycleMeetings(previous, rows));
    });
  }, [active, hits, isSearching, hasMotion, searchPending, query, searchRevision]);

  return { isSearching, hits, searchMeetings, searchPending, searchError, previousSearchQuery };
}
