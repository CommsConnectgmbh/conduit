#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/build.sh

osascript -e 'tell application "Conduit" to quit' 2>/dev/null || true
sleep 0.3

rm -rf "/Applications/Conduit.app"
ditto --noqtn --rsrc "dist/Conduit.app" "/Applications/Conduit.app"
xattr -dr com.apple.quarantine "/Applications/Conduit.app" 2>/dev/null || true

echo "✓ /Applications/Conduit.app installiert"
echo "→ starte App"
open "/Applications/Conduit.app"
