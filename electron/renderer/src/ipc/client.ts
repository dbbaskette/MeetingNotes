import type { MeetingNotesApi } from '../../../preload';

declare global {
  interface Window { api: MeetingNotesApi; }
}

export const api: MeetingNotesApi = window.api;
