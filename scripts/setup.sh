#!/usr/bin/env bash
set -euo pipefail

echo "MeetingNotes first-run setup"
echo "==="

# 1. Check prerequisites
command -v node >/dev/null || { echo "ERROR: Node.js not installed"; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: Python 3 not installed"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not installed (brew install ffmpeg)"; exit 1; }
command -v ffprobe >/dev/null || { echo "ERROR: ffprobe not installed"; exit 1; }

# 2. npm install
echo "Installing Node deps..."
npm install

# 3. Python sidecar venv
echo "Setting up Python sidecar..."
pushd sidecar >/dev/null
./scripts/install.sh
popd >/dev/null

# 4. Library directory
LIB="${HOME}/Documents/MeetingNotes"
mkdir -p "$LIB"/meetings "$LIB"/speakers/embeddings

echo "Setup complete."
echo "Before first use:"
echo "  export HF_TOKEN=<your-huggingface-token>"
echo "  Start LM Studio and load a Whisper model and a chat LLM"
echo "Then run: npm run dev"
