# Application icon

The 1.14.5 icon replaces the low-contrast dark metallic notebook/pen with a
bright pale rounded-square tile, an indigo conversation bubble and five bold
white waveform bars. Large simple shapes are intentional for small Dock/Finder
sizes and dark backgrounds. The in-app Library/Weekly logo matches the bundle.

Authoritative artwork: `build/icon-1024.png` (1024px RGBA PNG). Derived bundle:
`build/icon.icns`; matching 256px renderer asset:
`electron/renderer/src/assets/logo.png`. On macOS, run `npm run build:icons` to
export the ten standard 1×/2× iconset representations (16–1024px) with `sips`
and assemble the ICNS with `iconutil`. Some restricted environments require
permission for macOS native image services; do not bypass an export failure.

Artwork was created with the built-in image-generation tool, not a paid CLI
or runtime dependency. Prompt: “Single isolated macOS application icon for
MeetingNotes: bright warm-white/pale-lavender rounded-square tile, large bold
deep-indigo speech bubble containing five thick white rounded audio waveform
bars; strong small-size contrast, transparent outside the tile, no text, pen,
spiral notebook, metallic finish, mockup or watermark.” Final refinement:
“Preserve the tile/bubble/waveform composition; clean flat pale tile, smooth
continuous perimeter, remove disconnected speckles/fringes, transparent outside,
no exterior glow, texture, words or added elements.”

Changing these source assets does not update the installed app or reset the
Dock icon cache. A later build/install is required. App ID/signing identity,
recordings, settings and permissions are unchanged.
