export type ThemeChoice = 'system' | 'light' | 'dark';

/** Resolve the effective dark-mode boolean from the user's theme choice and
 *  the OS preference. 'system' defers to the OS; 'light'/'dark' override it. */
export function resolveDark(theme: ThemeChoice, systemPrefersDark: boolean): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return systemPrefersDark;
}
