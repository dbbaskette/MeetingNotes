// Renderer-side platform helper for keyboard shortcuts. The app ships only on
// macOS today, but the renderer also runs in `npm run dev` on Linux for
// non-recording UI work; falling back to "Ctrl" there keeps in-UI hints
// honest instead of always claiming "⌘".
export function shortcutMod(): string {
  const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘' : 'Ctrl';
}
