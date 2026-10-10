#!/bin/sh
# Builds the experimental Aion Audio Bridge as a small app bundle (macOS 14.2+), ad-hoc signed, so macOS can ask the
# user for "System Audio Recording Only" permission. Usage: ./build.sh [output-dir]  (default: ./build)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-"$HERE/build"}
APP="$OUT/Aion Audio Bridge.app"
mkdir -p "$APP/Contents/MacOS"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
xcrun swiftc -O -swift-version 5 "$HERE/AionAudioBridge.swift" -o "$APP/Contents/MacOS/aion-audio-bridge"
codesign --force --sign - "$APP"
echo "$APP"
