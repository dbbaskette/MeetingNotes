// build/trim-electron-framework.cjs
//
// electron-builder afterPack hook. Trims unused resources from
// Chromium's `Electron Framework.framework`:
//
//   1. Locale `.lproj` dirs (~37 MB). The framework ships ~55
//      directories of translated UI strings (menu templates, error
//      pages, accessibility labels) for every locale Chromium
//      supports. We're English-only so all but `en.lproj` /
//      `en_GB.lproj` are dead weight. `electronLanguages` doesn't
//      help — those are macOS-style strings dirs, not per-locale
//      `.pak` files. Chromium falls back to `en.lproj` cleanly
//      when a requested locale isn't present.
//
// Keep ALL graphics/software-rendering fallback libraries and their
// manifests. Hardware-only success is not proof they are runtime-unused;
// VMs and --disable-gpu startup are supported regression configurations.
//
// .cjs extension is required because the package's package.json sets
// `"type": "module"` — a plain `.js` here gets loaded as ESM and the
// `require`/`module.exports` calls below would throw.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEEP_LPROJ = new Set(['en.lproj', 'en_GB.lproj']);

module.exports = async (context) => {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const frameworkDir = path.join(
    context.appOutDir,
    appName,
    'Contents/Frameworks/Electron Framework.framework/Versions/A',
  );
  if (!fs.existsSync(frameworkDir)) return;

  // ── 1. Locale .lproj strip ──
  const resourcesDir = path.join(frameworkDir, 'Resources');
  if (fs.existsSync(resourcesDir)) {
    let removed = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(resourcesDir)) {
      if (!entry.endsWith('.lproj')) continue;
      if (KEEP_LPROJ.has(entry)) continue;
      const full = path.join(resourcesDir, entry);
      bytes += dirSize(full);
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    }
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`  • stripped ${removed} unused .lproj dirs (${mb(bytes)} MB)`);
    }
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

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}
