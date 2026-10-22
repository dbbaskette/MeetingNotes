# 1.19.1 startup hotfix verification

## Cause and reproduction

The installed 1.19.0 archive contained CommonJS `exports.ActionFilterSchema`
inside the ESM main-process tree. Importing the built Actions repository with
Electron's Node reproduced the user's exact missing-export exception before
any database or app startup code ran. Both TypeScript compilers previously
wrote to `dist`; a type-only preload import still caused TypeScript to emit the
shared module again using the preload's CommonJS format.

The preceding release's integrity checks compared packaged bytes with an already
broken build. Source tests and mocked renderer fixtures did not execute that
combined output. Those checks did not establish successful packaged startup.

## Fix

Implementation commit: `bc6e9d0`. Main output remains under `dist/electron`;
preload output uses the independent `dist/preload` tree and CommonJS package
boundary. Stable and beta windows point at the new preload entry points.
Development startup builds the preload before launching Electron.

Every production build now imports all emitted shared modules and the Actions
repository and verifies both preload scripts. Every local CI tier also launches
the real built app with a marked disposable library and checks actual paging,
Actions and speaker-review IPC, including on a permission-gated clean Mac.

## Verified locally

- Fixed production build and emitted-module guard passed.
- Stable source launch: populated Library, 50 paged rows, Actions and voice review
  through the real preload bridge; synthetic library only.
- Beta comparison UI opened with its relocated preload; saved notes/audio links
  and comparison controls passed against disposable fixture data.
- Actual signed package launched successfully with both normal rendering and
  SwiftShader. Both displayed the 600-meeting synthetic Library, paged 50 rows,
  returned zero fixture actions/reviews, and had zero active recordings.
- The exact failing Actions module imports successfully from `app.asar` using
  the packaged Electron executable.
- All 191 generated application files match the archive byte-for-byte.
- Deep/strict signature verification, DMG checksum verification and ZIP integrity
  passed. Signing remains Apple Development; no Developer ID notarization.
- Packaged helper enumeration and summary transport passed using synthetic HTTP
  responses. Existing native inference evidence is reused: speech code unchanged.
- No installed app replacement, user-library writes, capture or installer VM test.

DMG SHA-256: `cf3d0bfc6e3378e96d90918b9e011cd8eb42d2bd078b21c10d3874505282f0b2`.
ZIP SHA-256: `1ae6a7cbbef2a0c3c726cb81a011ecf42eb49af008301a5344f28986eb91bd4c`.

Full regression CI is pending at this checkpoint. Results will be recorded here
before merging and publishing the hotfix.
