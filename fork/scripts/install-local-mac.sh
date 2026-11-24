#!/usr/bin/env bash
# Build, verify, atomically overwrite-install, smoke-test, and launch
# T3 Lab (Extend) locally on Apple Silicon macOS without touching official
# T3 Code installs or ~/.t3/userdata.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash fork/scripts/install-local-mac.sh <version> [--skip-build] [--no-launch] [--dry-run]

Examples:
  bash fork/scripts/install-local-mac.sh 0.1.12-lab.3
  bash fork/scripts/install-local-mac.sh 0.1.12-lab.3 --skip-build --no-launch
EOF
}

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 2
fi

VERSION=""
SKIP_BUILD=0
NO_LAUNCH=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    --skip-build)
      SKIP_BUILD=1
      ;;
    --no-launch)
      NO_LAUNCH=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -*)
      echo "ERROR: Unknown option '$arg'" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "ERROR: Unexpected extra positional argument '$arg'" >&2
        usage >&2
        exit 2
      fi
      VERSION="$arg"
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "ERROR: Missing <version> argument (e.g. 0.1.12-lab.3)." >&2
  usage >&2
  exit 2
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: Invalid version '$VERSION' (expected semver such as 0.1.12-lab.3)." >&2
  exit 2
fi

if [ "${T3CODE_DESKTOP_UNTRUSTED_BUNDLE:-}" = "true" ] || [ "${T3CODE_DESKTOP_UNTRUSTED_BUNDLE:-}" = "1" ]; then
  echo "ERROR: Refusing local install with T3CODE_DESKTOP_UNTRUSTED_BUNDLE enabled (FORK.md red line)." >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "ERROR: install-local-mac.sh requires macOS arm64 (got $(uname -s)/$(uname -m))." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DMG="$REPO_ROOT/release/T3-Lab-Extend-${VERSION}-arm64.dmg"
BUNDLE_ID="com.davidlokus.t3lab"
APP_NAME="T3 Lab (Extend).app"
TARGET="/Applications/$APP_NAME"
STAGE="/Applications/.${APP_NAME}.staging"

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF
DRY RUN (no build, quit, overwrite, or launch executed):
  repo:    $REPO_ROOT
  version: $VERSION
  dmg:     $DMG
  target:  $TARGET
  steps:
    1. build:  $([ "$SKIP_BUILD" -eq 1 ] && echo "skipped (--skip-build)" || echo "GITHUB_REPOSITORY=\"\" T3CODE_DESKTOP_UPDATE_REPOSITORY=\"\" vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --build-version \"$VERSION\"")
    2. verify: bash fork/scripts/verify-mac-dmg.sh "$DMG" "$VERSION"
    3. quit:   osascript graceful quit for bundle id $BUNDLE_ID
    4. swap:   ditto DMG app -> $STAGE -> $TARGET (clearing com.apple.quarantine)
    5. smoke:  node scripts/smoke-desktop-app.ts --executable "$TARGET/Contents/MacOS/T3 Lab (Extend)"
    6. launch: $([ "$NO_LAUNCH" -eq 1 ] && echo "skipped (--no-launch)" || echo "open -a \"$TARGET\"")
EOF
  exit 0
fi

cd "$REPO_ROOT"

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "[1/6] Building unsigned arm64 DMG ($VERSION)..."
  GITHUB_REPOSITORY="" T3CODE_DESKTOP_UPDATE_REPOSITORY="" \
    vp run dist:desktop:artifact \
      --platform mac \
      --target dmg \
      --arch arm64 \
      --build-version "$VERSION"
else
  echo "[1/6] Skipping build (--skip-build); expecting existing $DMG"
fi

echo "[2/6] Verifying DMG branding, isolation, and boot..."
bash "$REPO_ROOT/fork/scripts/verify-mac-dmg.sh" "$DMG" "$VERSION"

if [ "$(osascript -e "application id \"$BUNDLE_ID\" is running")" = "true" ]; then
  echo "[3/6] Gracefully quitting running T3 Lab (Extend)..."
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" || true
  for _ in $(seq 1 30); do
    if [ "$(osascript -e "application id \"$BUNDLE_ID\" is running")" != "true" ]; then
      break
    fi
    sleep 0.5
  done
  if [ "$(osascript -e "application id \"$BUNDLE_ID\" is running")" = "true" ]; then
    echo "ERROR: T3 Lab (Extend) did not exit within 15s; aborting overwrite so no running binary is clobbered." >&2
    exit 1
  fi
else
  echo "[3/6] T3 Lab (Extend) is not currently running."
fi

MNT=$(mktemp -d "${TMPDIR:-/tmp}/t3lab-install-mnt-XXXXXX")
MOUNTED=0
cleanup() {
  if [ "$MOUNTED" -eq 1 ]; then
    hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet || true
    MOUNTED=0
  fi
  rmdir "$MNT" 2>/dev/null || true
  rm -rf "$STAGE" 2>/dev/null || true
}
trap cleanup EXIT

echo "[4/6] Installing $APP_NAME ($VERSION) to $TARGET..."
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" -quiet
MOUNTED=1

rm -rf "$STAGE"
ditto "$MNT/$APP_NAME" "$STAGE"
xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true
STAGE_VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$STAGE/Contents/Info.plist")
if [ "$STAGE_VER" != "$VERSION" ]; then
  echo "ERROR: Staged Info.plist version '$STAGE_VER' != expected '$VERSION'" >&2
  exit 1
fi

rm -rf "$TARGET"
mv "$STAGE" "$TARGET"
hdiutil detach "$MNT" -quiet
MOUNTED=0
echo "Installed $TARGET (version $STAGE_VER)"

echo "[5/6] Running isolated Playwright desktop launch smoke test..."
node "$REPO_ROOT/scripts/smoke-desktop-app.ts" \
  --executable "$TARGET/Contents/MacOS/T3 Lab (Extend)"

if [ "$NO_LAUNCH" -eq 0 ]; then
  echo "[6/6] Launching $TARGET..."
  open -a "$TARGET"
else
  echo "[6/6] Skipping launch (--no-launch)."
fi
