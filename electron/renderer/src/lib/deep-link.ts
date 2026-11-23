// electron/renderer/src/lib/deep-link.ts
//
// In-app deep links (#298, #299). Hints such as "Connect a Google account in
// Settings" or "Choose yourself under Settings → Speakers" were plain text,
// and Prepare next meeting could not jump to a group's open actions. Any
// component can now request navigation without the App's navigate() being
// threaded down to it; App listens and routes through its history.
export type SettingsSectionName = 'Recording' | 'Processing' | 'Organization' | 'Integrations' | 'Storage' | 'Advanced';

export type DeepLink =
  | { kind: 'settings'; section?: SettingsSectionName }
  | { kind: 'actions'; groupId?: string | null }
  | { kind: 'detail'; id: string }
  | { kind: 'library' };

const EVENT = 'mn:navigate';

export function requestNavigation(link: DeepLink): void {
  window.dispatchEvent(new CustomEvent<DeepLink>(EVENT, { detail: link }));
}

export function onNavigationRequest(handler: (link: DeepLink) => void): () => void {
  const listener = (event: Event): void => handler((event as CustomEvent<DeepLink>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
