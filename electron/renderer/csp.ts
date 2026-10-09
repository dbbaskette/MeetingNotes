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
//   connect-src  one endpoint: the Hugging Face token check in onboarding.
export const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'data:'],
  'media-src': ["'self'", 'file:', 'data:', 'blob:', 'recovery-audio:'],
  'connect-src': ["'self'", 'https://huggingface.co'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

export function contentSecurityPolicy(): string {
  return Object.entries(CSP_DIRECTIVES).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}
