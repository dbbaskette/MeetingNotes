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
//   2. WebGL software-rasterizer libs (~23 MB). `libvk_swiftshader.dylib`
//      (16 MB) and `libGLESv2.dylib` (6.9 MB) are software-rendering
//      fallbacks Chromium uses when GPU acceleration is unavailable.
//      MeetingNotes renders zero WebGL / Canvas3D / WebGPU surfaces
//      — the entire UI is regular DOM + CSS animations — so on
//      Apple Silicon hardware these libs never get exercised. The
//      tradeoff: if Chromium falls into software-rendering mode on
//      weird hardware (some VMs, certain accessibility tools that
//      force `--disable-gpu`), the app would render a blank window.
//      We accept this risk on a Mac-only ARM64 distribution.
//
// .cjs extension is required because the package's package.json sets
// `"type": "module"` — a plain `.js` here gets loaded as ESM and the
// `require`/`module.exports` calls below would throw.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEEP_LPROJ = new Set(['en.lproj', 'en_GB.lproj']);

// Software-rendering fallback libs Chromium ships in the framework.
// Removed because we don't render any GL/Vulkan surface and the
// hardware path covers every Apple Silicon Mac in production.
const STRIP_GPU_LIBS = new Set([
  'libvk_swiftshader.dylib',
  'libGLESv2.dylib',
  // ICD manifest pointing at libvk_swiftshader. Without the lib it
  // points to, Chromium logs a "failed to load Vulkan ICD" warning
  // every launch. Drop it too. ~150 bytes — purely about cleanliness.
  'vk_swiftshader_icd.json',
  // libvulkan.1.x.x.dylib is a hard dep of libvk_swiftshader; if we
  // remove the latter we should remove the former too. Conditionally
  // matched via a regex below since the version suffix moves.
]);
const STRIP_GPU_LIBS_RE = /^libvulkan\..*\.dylib$/;

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

  // ── 2. Software-WebGL fallback libs strip ──
  const librariesDir = path.join(frameworkDir, 'Libraries');
  if (fs.existsSync(librariesDir)) {
    let removed = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(librariesDir)) {
      const targeted = STRIP_GPU_LIBS.has(entry) || STRIP_GPU_LIBS_RE.test(entry);
      if (!targeted) continue;
      const full = path.join(librariesDir, entry);
      try {
        bytes += fs.statSync(full).size;
      } catch { /* missing — ignore */ }
      fs.rmSync(full, { force: true });
      removed += 1;
    }
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`  • stripped ${removed} GPU fallback libs (${mb(bytes)} MB)`);
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
