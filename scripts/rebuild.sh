#!/usr/bin/env bash
# rebuild.sh — Full clean build of MeetingNotes + installable .dmg/.zip
#
# Usage:
#   ./scripts/rebuild.sh          # full rebuild (audio-tap + sidecar + app + package)
#   ./scripts/rebuild.sh --skip-sidecar   # skip the slow PyInstaller sidecar bundle
#   ./scripts/rebuild.sh --skip-audio-tap # skip the Swift audio-tap helper
#   ./scripts/rebuild.sh --app-only       # skip both, just rebuild the Electron app + package
#
# Output:
#   release/MeetingNotes-<version>.dmg
#   release/MeetingNotes-<version>-mac.zip
set -euo pipefail
cd "$(dirname "$0")/.."

# ── Flags ──────────────────────────────────────────────────────────────
SKIP_SIDECAR=false
SKIP_AUDIO_TAP=false

for arg in "$@"; do
  case "$arg" in
    --skip-sidecar)   SKIP_SIDECAR=true ;;
    --skip-audio-tap) SKIP_AUDIO_TAP=true ;;
    --app-only)       SKIP_SIDECAR=true; SKIP_AUDIO_TAP=true ;;
    -h|--help)
      sed -n '2,/^set /{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

step() { echo -e "\n${BOLD}${GREEN}▸ $1${RESET}"; }
warn() { echo -e "${YELLOW}⚠ $1${RESET}"; }
fail() { echo -e "${RED}✖ $1${RESET}" >&2; exit 1; }

SECONDS=0  # bash built-in timer

# ── Preflight checks ──────────────────────────────────────────────────
step "Preflight checks"

command -v node  >/dev/null || fail "node not found"
command -v npm   >/dev/null || fail "npm not found"
echo "  node $(node -v)  •  npm $(npm -v)"

VERSION=$(node -e "console.log(require('./package.json').version)")
echo "  MeetingNotes v${VERSION}"

if ! $SKIP_AUDIO_TAP; then
  command -v xcrun >/dev/null || fail "Xcode command-line tools not found (needed for audio-tap)"
fi

if ! $SKIP_SIDECAR; then
  [ -x sidecar/.venv/bin/python ] || fail "Sidecar venv missing — run: cd sidecar && ./scripts/install.sh"
fi

# ── Step 1: Audio-tap (Swift helper) ──────────────────────────────────
if $SKIP_AUDIO_TAP; then
  warn "Skipping audio-tap build (--skip-audio-tap)"
  [ -f audio-tap/build/meeting-notes-tap ] || warn "  ⚠ No existing audio-tap binary — the .dmg will be missing it"
else
  step "Building audio-tap (Swift)"
  npm run build:audio-tap
fi

# ── Step 2: Sidecar (PyInstaller bundle) ──────────────────────────────
if $SKIP_SIDECAR; then
  warn "Skipping sidecar bundle (--skip-sidecar)"
  [ -d sidecar/dist/meeting-notes-diarize ] || warn "  ⚠ No existing sidecar bundle — the .dmg will be missing it"
else
  step "Building sidecar (PyInstaller — this takes a while)"
  npm run sidecar:bundle
fi

# ── Step 3: Electron app (TypeScript + Vite) ──────────────────────────
step "Rebuilding native modules for Electron"
npm run rebuild:electron

step "Building Electron app (TypeScript + Vite)"
npm run build

# ── Step 4: Wipe stale artifacts ──────────────────────────────────────
# Without this, every prior version's .dmg/.zip lives forever in
# release/ and the post-build "Install:" hint picks the alphabetically
# first one (e.g. 0.1.0.dmg even though we just built 0.2.0). Cleaning
# also dodges the disk-fills-up-over-many-rebuilds problem.
#
# We don't `rm -rf release/` — electron-builder writes some persistent
# state (latest-mac.yml, builder-effective-config.yaml, .icon-icns/)
# that's faster left in place. Just the user-facing artifacts go.
step "Removing old release artifacts"
rm -f release/MeetingNotes-*.dmg \
      release/MeetingNotes-*.dmg.blockmap \
      release/MeetingNotes-*-mac.zip \
      release/MeetingNotes-*-mac.zip.blockmap 2>/dev/null || true

# ── Step 5: Package with electron-builder ─────────────────────────────
step "Packaging .dmg and .zip with electron-builder"
npx electron-builder --mac

# ── Step 6: Clean up loose .app ───────────────────────────────────────
step "Cleaning up loose .app (use the .dmg instead)"
npm run dist:cleanup-loose-app 2>/dev/null || true

# ── Done ──────────────────────────────────────────────────────────────
ELAPSED=$SECONDS
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

step "Build complete in ${MINS}m ${SECS}s"
echo ""
echo "  Installable packages:"
ls -lh release/MeetingNotes-*.{dmg,zip} 2>/dev/null | awk '{print "    " $NF " (" $5 ")"}'
echo ""
DMG=$(ls release/MeetingNotes-*.dmg 2>/dev/null | head -1)
echo "  Install:  open ${DMG:-release/}"
echo ""
