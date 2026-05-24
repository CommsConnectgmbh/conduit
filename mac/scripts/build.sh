#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Conduit"
BIN_NAME="ConduitMacApp"
DIST="dist/${APP_NAME}.app"

echo "→ swift build -c release"
swift build -c release --arch arm64

echo "→ assemble bundle"
rm -rf "${DIST}"
mkdir -p "${DIST}/Contents/MacOS" "${DIST}/Contents/Resources"

cp ".build/release/${BIN_NAME}" "${DIST}/Contents/MacOS/${APP_NAME}"
chmod +x "${DIST}/Contents/MacOS/${APP_NAME}"
cp "Resources/Info.plist" "${DIST}/Contents/Info.plist"
if [ -f "Resources/AppIcon.icns" ]; then
  cp "Resources/AppIcon.icns" "${DIST}/Contents/Resources/AppIcon.icns"
fi
printf "APPL????" > "${DIST}/Contents/PkgInfo"

echo "→ ad-hoc codesign"
codesign --force --deep --sign - --options runtime --entitlements scripts/entitlements.plist "${DIST}" 2>/dev/null \
  || codesign --force --deep --sign - "${DIST}"

echo "✓ ${DIST}"
