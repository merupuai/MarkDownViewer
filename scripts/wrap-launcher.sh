#!/bin/sh
# wrap-launcher.sh — install the Cocoa launcher wrapper into the .app bundle.
#
# Why: macOS LaunchServices delivers the file path passed when a user
# double-clicks a .md file via the kAEOpenDocuments AppleEvent
# (NSApplication.application(_:open:)). Electrobun's Zig launcher is
# not a Cocoa app, so the event is dropped, and Bun starts up too late
# to receive it. Our cocoa-launcher.swift binary intercepts that event,
# writes the URL to /tmp/mdv-pending-url-<pid>, and execs the real launcher.
#
# Usage: scripts/wrap-launcher.sh <path-to-Markdown Viewer.app>

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$1"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "usage: $0 <path-to-app>" >&2
  exit 1
fi

LAUNCHER="$APP/Contents/MacOS/launcher"
LAUNCHER_REAL="$APP/Contents/MacOS/launcher.real"
COCOA="$PROJECT_ROOT/build/tools/cocoa-launcher"

if [ ! -f "$COCOA" ]; then
  echo "Building cocoa-launcher..." >&2
  mkdir -p "$PROJECT_ROOT/build/tools"
  swiftc -O "$PROJECT_ROOT/scripts/cocoa-launcher.swift" -o "$COCOA"
fi

if [ ! -f "$LAUNCHER" ]; then
  echo "launcher not found: $LAUNCHER" >&2
  exit 1
fi

# Detect already wrapped via shebang or by file size (Mach-O)
if [ -f "$LAUNCHER_REAL" ]; then
  echo "Already wrapped — replacing wrapper binary."
  rm -f "$LAUNCHER"
else
  mv "$LAUNCHER" "$LAUNCHER_REAL"
fi

cp "$COCOA" "$LAUNCHER"
chmod +x "$LAUNCHER"
echo "Wrapped: $LAUNCHER (real binary at launcher.real)"
