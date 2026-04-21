// electron/main/meeting-detector/applescript.ts
//
// Query the active-tab URL of the frontmost browser window without actually
// activating the browser. AppleScript is the cheapest cross-browser signal
// we have; each script runs in ~50ms on warm AppleScript caches.
//
// Scripts return an empty string if the browser isn't running (the "tell
// application X" block exits clean with no error) or if the app has no
// open windows. Callers should treat "" as "no active tab."

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export type BrowserKind = 'safari' | 'chrome' | 'arc' | 'edge' | 'brave';

export interface ActiveTab {
  browser: BrowserKind;
  url: string;
  title: string | null;
  pid: number;
}

type Runner = (cmd: string, args: string[], opts?: { timeout?: number }) =>
  Promise<{ stdout: string; stderr: string }>;

// Using script form that bails silently if the app isn't running. `running`
// is a built-in property on `application` objects and doesn't require the
// app to be open to read.
const SCRIPTS: Record<BrowserKind, string> = {
  safari: `
if application "Safari" is running then
  tell application "Safari"
    if (count of windows) > 0 then
      set theURL to URL of current tab of front window
      set theTitle to name of current tab of front window
      return theURL & linefeed & theTitle
    end if
  end tell
end if
return ""`,
  chrome: `
if application "Google Chrome" is running then
  tell application "Google Chrome"
    if (count of windows) > 0 then
      set theURL to URL of active tab of front window
      set theTitle to title of active tab of front window
      return theURL & linefeed & theTitle
    end if
  end tell
end if
return ""`,
  arc: `
if application "Arc" is running then
  tell application "Arc"
    if (count of windows) > 0 then
      set theURL to URL of active tab of front window
      set theTitle to title of active tab of front window
      return theURL & linefeed & theTitle
    end if
  end tell
end if
return ""`,
  edge: `
if application "Microsoft Edge" is running then
  tell application "Microsoft Edge"
    if (count of windows) > 0 then
      set theURL to URL of active tab of front window
      set theTitle to title of active tab of front window
      return theURL & linefeed & theTitle
    end if
  end tell
end if
return ""`,
  brave: `
if application "Brave Browser" is running then
  tell application "Brave Browser"
    if (count of windows) > 0 then
      set theURL to URL of active tab of front window
      set theTitle to title of active tab of front window
      return theURL & linefeed & theTitle
    end if
  end tell
end if
return ""`,
};

// Unix process name -> BrowserKind. Used to resolve the PID so the source
// picker can pre-select the right row.
const PROCESS_NAMES: Record<BrowserKind, string> = {
  safari: 'Safari',
  chrome: 'Google Chrome',
  arc: 'Arc',
  edge: 'Microsoft Edge',
  brave: 'Brave Browser',
};

export async function queryBrowserTab(
  browser: BrowserKind,
  deps: { runner?: Runner } = {},
): Promise<Omit<ActiveTab, 'pid'> | null> {
  const runner = deps.runner ?? ((c, a, o) => pExecFile(c, a, { timeout: o?.timeout ?? 3000 }));
  try {
    const { stdout } = await runner('osascript', ['-e', SCRIPTS[browser]], { timeout: 3000 });
    const text = stdout.trim();
    if (!text) return null;
    const [url, ...titleLines] = text.split('\n');
    if (!url || !/^https?:\/\//i.test(url)) return null;
    return { browser, url, title: titleLines.join('\n') || null };
  } catch {
    // AppleScript can fail if the app is restarting or Automation perms
    // haven't been granted — treat as "no active tab", don't spam the log.
    return null;
  }
}

export async function resolveBrowserPid(
  browser: BrowserKind,
  deps: { runner?: Runner } = {},
): Promise<number | null> {
  const runner = deps.runner ?? ((c, a, o) => pExecFile(c, a, { timeout: o?.timeout ?? 2000 }));
  try {
    const { stdout } = await runner('pgrep', ['-x', PROCESS_NAMES[browser]], { timeout: 2000 });
    const first = stdout.trim().split('\n')[0];
    const pid = first ? Number(first) : NaN;
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function queryAllBrowsers(
  deps: { runner?: Runner } = {},
): Promise<ActiveTab[]> {
  const kinds: BrowserKind[] = ['arc', 'chrome', 'safari', 'edge', 'brave'];
  const tabs = await Promise.all(kinds.map(async (k) => {
    const tab = await queryBrowserTab(k, deps);
    if (!tab) return null;
    const pid = await resolveBrowserPid(k, deps);
    if (pid == null) return null;
    return { ...tab, pid } satisfies ActiveTab;
  }));
  return tabs.filter((t): t is ActiveTab => t !== null);
}
