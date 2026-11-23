import type { SchemeDispatcher } from './url-scheme/dispatcher.js';

// meetingnotes:// URLs that arrive before the dispatcher exists (a cold-start
// `open meetingnotes://record`) are buffered here and replayed once whenReady()
// has built the dispatcher. Issue #77.
const pendingSchemeUrls: string[] = [];
let schemeDispatcher: SchemeDispatcher | null = null;

export function handleSchemeUrl(url: string): void {
  if (schemeDispatcher) void schemeDispatcher.dispatch(url);
  else pendingSchemeUrls.push(url);
}

/** Installs the dispatcher and flushes the URLs buffered before it existed. */
export function setSchemeDispatcher(dispatcher: SchemeDispatcher): void {
  schemeDispatcher = dispatcher;
  for (const url of pendingSchemeUrls.splice(0)) {
    void schemeDispatcher.dispatch(url);
  }
}
