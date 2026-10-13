#!/bin/sh
# Builds the Aion Audio Bridge as a small app bundle (macOS 14.2+), ad-hoc signed, so macOS can ask the user for
# "System Audio Recording Only" permission. Usage: ./build.sh [output-dir]  (default: ./build)
# macOS remembers the permission for this exact build: rebuilding (a new signature) asks again. Install it once in a
# stable place (npm run audio-bridge:install → ~/.aion-presence/audio-bridge) and keep it there.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-"$HERE/build"}
# Built and signed outside the output folder: synced folders (iCloud Documents) add attributes codesign refuses.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Aion Audio Bridge.app"
mkdir -p "$APP/Contents/MacOS"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
xcrun swiftc -O -swift-version 5 "$HERE/AionAudioBridge.swift" -o "$APP/Contents/MacOS/aion-audio-bridge"
xattr -cr "$APP"
codesign --force --sign - "$APP"
codesign --verify "$APP"
mkdir -p "$OUT"
rm -rf "$OUT/Aion Audio Bridge.app"
ditto "$APP" "$OUT/Aion Audio Bridge.app"
echo "$OUT/Aion Audio Bridge.app"
