export interface SearchFacets {
  from?: string;
  to?: string;
  week?: string;
  speakerId?: string;
  status?: 'pending' | 'processing' | 'awaiting_user' | 'done' | 'failed';
  actions?: 'open' | 'mine';
  source?: 'capture' | 'import';
  warning?: boolean;
  content?: 'summary' | 'transcript';
}
export interface SearchHit {
  meetingId: string;
  title: string;
  groupName?: string | null;
  source: 'title' | 'summary' | 'transcript';
  snippet: string;
  seconds?: number;
}
export interface SearchResponse {
  hits: SearchHit[];
  status: 'complete' | 'partial' | 'limit' | 'failed' | 'cancelled';
  message?: string;
}
export interface SearchRequest {
  clientId: string;
  requestId: number;
  facets?: SearchFacets;
}
