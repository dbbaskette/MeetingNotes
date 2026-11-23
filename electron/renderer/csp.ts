// Content-Security-Policy for the packaged renderer (#249).
//
// Injected at build time only: Vite's dev server needs inline scripts and a
// websocket for hot reload, which this policy forbids on purpose.
//
// Every source is listed for a reason:
//   script-src   the bundled app and theme-boot.js. No inline, no eval.
//   style-src    bundled CSS, plus inline style attributes that React sets
//                for virtualised rows and progress bars.
//   img-src      bundled images and data: URIs.
//   media-src    meeting audio (file:), speaker samples (data:), and the
//                capture-recovery preview protocol (recovery-audio:).
//   connect-src  the app's own origin only. The renderer makes no network
//                requests; model downloads and LLM calls run in the main
//                process. (The Hugging Face token check that once needed an
//                exception here was removed in 1.16.)
export const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'data:'],
  'media-src': ["'self'", 'file:', 'data:', 'blob:', 'recovery-audio:'],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

/** The speech-beta comparison page plays audio through its own protocol. It
 *  ships only in the separate beta package, so the production page's policy
 *  does not carry this source. */
export const BETA_MEDIA_SOURCE = 'beta-audio:';

export function contentSecurityPolicy(page: 'app' | 'beta' = 'app'): string {
  return Object.entries(CSP_DIRECTIVES).map(([name, sources]) => {
    const all = page === 'beta' && name === 'media-src' ? [...sources, BETA_MEDIA_SOURCE] : sources;
    return `${name} ${all.join(' ')}`;
  }).join('; ');
}
