#!/bin/sh
# install-macos.sh — Build, install, and register the Markdown Viewer on macOS.
#
# Usage:
#   ./scripts/install-macos.sh              # builds stable + installs
#   ./scripts/install-macos.sh --no-build   # skip build, just install existing artifact
#   ./scripts/install-macos.sh --no-default # don't make it the system default for .md
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

DO_BUILD=1
SET_DEFAULT=1
for arg in "$@"; do
  case "$arg" in
    --no-build)   DO_BUILD=0 ;;
    --no-default) SET_DEFAULT=0 ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
  esac
done

# Verify Bun is available
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "Bun not found. Install it: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
fi

# 1) Install dependencies if needed
if [ ! -d node_modules ]; then
  echo "==> Installing dependencies"
  bun install
fi

# 2) Build (postWrap hook automatically wraps the launcher)
if [ "$DO_BUILD" = "1" ]; then
  echo "==> Building stable bundle"
  bunx electrobun build --env=stable
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  BUILD_DIR="build/stable-macos-arm64" ;;
  x86_64) BUILD_DIR="build/stable-macos-x64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

APP_SRC="$BUILD_DIR/Markdown Viewer.app"
APP_DST="/Applications/Markdown Viewer.app"

if [ ! -d "$APP_SRC" ]; then
  echo "Build output not found: $APP_SRC" >&2
  exit 1
fi

# 3) Stop running instances
pkill -9 -f "Markdown Viewer.app" 2>/dev/null || true
sleep 1

# 4) Install
echo "==> Installing $APP_DST"
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"

# 5) Verify wrap is in place (postwrap should have done this on the build dir)
if [ ! -f "$APP_DST/Contents/MacOS/launcher.real" ]; then
  echo "==> Installing Cocoa launcher wrapper"
  ./scripts/wrap-launcher.sh "$APP_DST"
fi

# 6) Register with LaunchServices
LSR=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Support/lsregister
echo "==> Registering with LaunchServices"
"$LSR" -f "$APP_DST"

# 7) Set as default for .md
if [ "$SET_DEFAULT" = "1" ]; then
  echo "==> Setting as default handler for .md"
  swift "$PROJECT_ROOT/scripts/set-default-handler.swift" >/dev/null 2>&1 || true
fi

echo ""
echo "Installed: $APP_DST"
echo "Try: open /path/to/file.md"
