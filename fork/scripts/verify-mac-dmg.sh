#!/usr/bin/env bash
# Read-only verification of a packaged T3 Lab (Extend) macOS arm64 DMG.
# Asserts branding, Bundle ID, URL schemes, absence of app-update.yml,
# presence of server-compile-cache, arm64 binary arch, and --version boot.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: bash fork/scripts/verify-mac-dmg.sh <path-to-dmg> [expected-version]" >&2
  exit 2
fi

DMG="$1"
EXPECTED_VERSION="${2:-}"

if [ ! -f "$DMG" ]; then
  echo "FAIL: DMG not found: $DMG" >&2
  exit 1
fi

TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
MNT=$(mktemp -d "${TMP_BASE}/t3lab-verify-dmg-XXXXXX")
MOUNTED=0
cleanup() {
  if [ "$MOUNTED" -eq 1 ]; then
    hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet || true
    MOUNTED=0
  fi
  rmdir "$MNT" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" -quiet
MOUNTED=1

APP="$MNT/T3 Lab (Extend).app"
if [ ! -d "$APP" ]; then
  echo "FAIL: Missing expected app bundle 'T3 Lab (Extend).app' in DMG" >&2
  ls -la "$MNT" >&2
  exit 1
fi

PLIST="$APP/Contents/Info.plist"
check_plist() {
  local key="$1"
  local expected="$2"
  local actual
  actual=$(/usr/libexec/PlistBuddy -c "Print :$key" "$PLIST")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: Info.plist $key expected '$expected', got '$actual'" >&2
    exit 1
  fi
  echo "PASS  Info.plist $key = $actual"
}

check_plist CFBundleName "T3 Lab (Extend)"
check_plist CFBundleDisplayName "T3 Lab (Extend)"
check_plist CFBundleIdentifier "com.davidlokus.t3lab"

ACTUAL_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST")
if [ -n "$EXPECTED_VERSION" ] && [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "FAIL: CFBundleShortVersionString expected '$EXPECTED_VERSION', got '$ACTUAL_VERSION'" >&2
  exit 1
fi
echo "PASS  Info.plist CFBundleShortVersionString = $ACTUAL_VERSION"

URL_TYPES=$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PLIST")
if ! printf '%s\n' "$URL_TYPES" | grep -Eq '^[[:space:]]+t3lab$'; then
  echo "FAIL: URL scheme 't3lab' missing from CFBundleURLTypes" >&2
  exit 1
fi
if ! printf '%s\n' "$URL_TYPES" | grep -Eq '^[[:space:]]+t3lab-dev$'; then
  echo "FAIL: URL scheme 't3lab-dev' missing from CFBundleURLTypes" >&2
  exit 1
fi
if printf '%s\n' "$URL_TYPES" | grep -Eq '^[[:space:]]+t3code(-dev)?$'; then
  echo "FAIL: Upstream URL scheme 't3code' leaked into CFBundleURLTypes" >&2
  exit 1
fi
echo "PASS  CFBundleURLTypes = t3lab, t3lab-dev (no upstream t3code scheme)"

if [ -e "$APP/Contents/Resources/app-update.yml" ]; then
  echo "FAIL: Unexpected app-update.yml present in Resources" >&2
  exit 1
fi
echo "PASS  No app-update.yml bundled"

if [ ! -d "$APP/Contents/Resources/server-compile-cache" ]; then
  echo "FAIL: Missing prepared server-compile-cache directory in Resources" >&2
  exit 1
fi
echo "PASS  Prepared server-compile-cache present"

BIN="$APP/Contents/MacOS/T3 Lab (Extend)"
FILE_INFO=$(file "$BIN")
if ! printf '%s' "$FILE_INFO" | grep -q "arm64"; then
  echo "FAIL: Expected arm64 executable, got: $FILE_INFO" >&2
  exit 1
fi
echo "PASS  Executable arch = arm64"

BOOT_VERSION=$("$BIN" --version)
if [ "$BOOT_VERSION" != "$ACTUAL_VERSION" ]; then
  echo "FAIL: '--version' printed '$BOOT_VERSION', expected '$ACTUAL_VERSION'" >&2
  exit 1
fi
echo "PASS  Packaged '--version' boot = $BOOT_VERSION"
