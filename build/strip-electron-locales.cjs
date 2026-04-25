// build/strip-electron-locales.cjs
//
// electron-builder afterPack hook. Trims unused locale resources from
// Chromium's `Electron Framework.framework`. The framework ships ~55
// `.lproj` directories — Chromium's translated UI strings (menu bar
// templates, error pages, accessibility labels) for every locale it
// supports. We're English-only so all but `en.lproj` are dead weight,
// adding ~37 MB to the .app.
//
// `electronLanguages` in electron-builder's config doesn't help here
// because this Electron build bundles all locales into a single
// `resources.pak` plus `.lproj` strings dirs, with no per-locale
// `.pak` files for `electronLanguages` to filter.
//
// If the host macOS preferred-language is something other than
// English, Chromium falls back to `en.lproj` cleanly when the
// requested locale isn't present — verified against Apple's own
// "missing locale" fallback chain. Any user-facing English string we
// own is shipped through Vite's bundle, not through these strings
// files, so this can't affect our own UI.
//
// .cjs extension is required because the package's package.json sets
// `"type": "module"` — a plain `.js` here gets loaded as ESM and the
// `require`/`module.exports` calls below would throw.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEEP = new Set(['en.lproj', 'en_GB.lproj']);

module.exports = async (context) => {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesDir = path.join(
    context.appOutDir,
    appName,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources',
  );
  if (!fs.existsSync(resourcesDir)) return;

  let removed = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(resourcesDir)) {
    if (!entry.endsWith('.lproj')) continue;
    if (KEEP.has(entry)) continue;
    const full = path.join(resourcesDir, entry);
    bytes += dirSize(full);
    fs.rmSync(full, { recursive: true, force: true });
    removed += 1;
  }
  if (removed > 0) {
    // eslint-disable-next-line no-console
    console.log(`  • stripped ${removed} unused .lproj dirs (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  }
};

function dirSize(p) {
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}
