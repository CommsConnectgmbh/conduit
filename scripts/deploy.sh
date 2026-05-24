#!/usr/bin/env bash
# Deploys both halves: web -> Vercel, bridge -> ~/Library/conduit-bridge.
# Run after editing code.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_DST="$HOME/Library/conduit-bridge"
LABEL="${CONDUIT_LABEL:-de.example.conduit-bridge}"

# Optional: load a shared env file with VERCEL_TOKEN etc. — adjust path or remove.
if [ -f "/Volumes/Code/ClaudeCode/.env.shared" ]; then
  source /Volumes/Code/ClaudeCode/.env.shared
fi

echo "════ web → Vercel production"
cd "$ROOT/web"
if [ -n "${VERCEL_TOKEN:-}" ]; then
  vercel deploy --prod --token "$VERCEL_TOKEN" --yes | tail -5
else
  vercel deploy --prod --yes | tail -5
fi

echo ""
echo "════ bridge → $BRIDGE_DST"
mkdir -p "$BRIDGE_DST/src"
cp "$ROOT/bridge/src/"*.mjs "$BRIDGE_DST/src/"
cp "$ROOT/bridge/package.json" "$BRIDGE_DST/"
if [ ! -d "$BRIDGE_DST/node_modules" ]; then
  (cd "$BRIDGE_DST" && npm install --omit=dev)
fi
if [ -f "$ROOT/bridge/.env.local" ] && [ ! -f "$BRIDGE_DST/.env.local" ]; then
  cp "$ROOT/bridge/.env.local" "$BRIDGE_DST/.env.local"
fi
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true
sleep 2
echo "bridge healthz: $(curl -s http://127.0.0.1:8787/healthz)"
echo ""
echo "✔ done"
