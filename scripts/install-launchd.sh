#!/usr/bin/env bash
# Installs the launchd agent that runs the bridge on macOS.
# Renders the plist template with your local paths, then bootstraps it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${CONDUIT_LABEL:-de.example.conduit-bridge}"
PLIST_OUT="$HOME/Library/LaunchAgents/${LABEL}.plist"
TEMPLATE="$ROOT/infra/de.example.conduit-bridge.plist.template"

if [ ! -f "$TEMPLATE" ]; then
  echo "missing template: $TEMPLATE" >&2; exit 1
fi
if [ ! -f "$ROOT/bridge/.env.local" ]; then
  echo "create $ROOT/bridge/.env.local first (cp .env.example .env.local)" >&2; exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/conduit-bridge"

sed \
  -e "s|REPLACE_WITH_REPO_PATH|${ROOT}|g" \
  -e "s|REPLACE_WITH_HOME|${HOME}|g" \
  -e "s|de.example.conduit-bridge|${LABEL}|g" \
  "$TEMPLATE" > "$PLIST_OUT"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_OUT"
launchctl enable "gui/$(id -u)/${LABEL}"

echo "✓ ${LABEL} installed at $PLIST_OUT"
echo ""
sleep 2
curl -s http://127.0.0.1:8787/healthz && echo
