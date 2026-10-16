#!/usr/bin/env bash
# Launch the current source build without stopping apps or adopting services.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  --dev) exec npm run dev ;;
  --help|-h) echo 'start.sh [--dev|--status] — native-only MeetingNotes'; exit 0 ;;
  --status) exec bash scripts/doctor.sh ;;
  '') ;;
  *) echo 'Unknown option. Legacy server management was removed; use the older release if needed.' >&2; exit 2 ;;
esac
[[ -f dist/electron/main/index.js ]] || { echo 'Run ./scripts/setup.sh first.' >&2; exit 1; }
exec npm start
