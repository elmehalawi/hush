#!/bin/bash
set -e

# Release script for Hush
# Usage: ./release.sh <version> <build_number>
# Example: ./release.sh 1.2.0 42

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_DIR="$SCRIPT_DIR/macos"
INFO_PLIST="$MACOS_DIR/signal-app-macOS/Info.plist"
SPARKLE_TOOLS="$SCRIPT_DIR/sparkle-tools"
RELEASES_DIR="$SCRIPT_DIR/releases"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_step() { echo -e "${BLUE}==>${NC} ${GREEN}$1${NC}"; }
log_warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
log_error() { echo -e "${RED}Error:${NC} $1"; }

VERSION="$1"
BUILD="$2"

if [ -z "$VERSION" ] || [ -z "$BUILD" ]; then
    echo "Usage: $0 <version> <build_number>"
    echo "Example: $0 1.2.0 42"
    exit 1
fi

APP_NAME="Hush"
DMG_NAME="${APP_NAME}-${VERSION}.dmg"

echo ""
echo "=========================================="
echo "  Hush Release v${VERSION} (build ${BUILD})"
echo "=========================================="
echo ""

# Preflight checks
if [ ! -d "$SPARKLE_TOOLS" ]; then
    log_error "sparkle-tools/ not found."
    echo "  Download Sparkle 2 from https://github.com/sparkle-project/Sparkle/releases"
    echo "  Extract bin/ into sparkle-tools/bin/"
    exit 1
fi

if ! command -v gh &> /dev/null; then
    log_error "GitHub CLI (gh) not found. Install with: brew install gh"
    exit 1
fi

# Step 1: Update version in Info.plist
log_step "Setting version to ${VERSION} (${BUILD})..."
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${BUILD}" "$INFO_PLIST"

# Step 2: Build the app in release mode
log_step "Building release..."
"$SCRIPT_DIR/build.sh" --release

# Find the built app
BUILD_DIR="$HOME/Library/Developer/Xcode/DerivedData"
APP_PATH=$(find "$BUILD_DIR" -name "${APP_NAME}.app" -path "*signal-app-*" -path "*Release*" 2>/dev/null | head -1)

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
    log_error "Release build not found"
    exit 1
fi

echo "  App: $APP_PATH"

# Step 3: Create DMG
log_step "Creating DMG..."
mkdir -p "$RELEASES_DIR"
DMG_PATH="$RELEASES_DIR/$DMG_NAME"
rm -f "$DMG_PATH"

# Create a temporary directory for the DMG contents
DMG_STAGING=$(mktemp -d)
cp -R "$APP_PATH" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$DMG_STAGING" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

rm -rf "$DMG_STAGING"
echo "  DMG: $DMG_PATH"

# Step 4: Sign the DMG with Sparkle's EdDSA key
log_step "Signing DMG with Sparkle EdDSA key..."
SIGNATURE=$("$SPARKLE_TOOLS/bin/sign_update" "$DMG_PATH")
echo "  Signature: $SIGNATURE"

# Step 5: Create GitHub release (so we know the download URL for appcast)
log_step "Creating GitHub release..."
TAG="v${VERSION}"
GITHUB_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/${DMG_NAME}"

RELEASE_NOTES="${RELEASE_NOTES:-"## ${APP_NAME} v${VERSION}

### Changes
- (fill in release notes)

### Install
Download **${DMG_NAME}**, open it, and drag ${APP_NAME} to Applications."}"

gh release create "$TAG" \
    "$DMG_PATH" \
    --title "${APP_NAME} ${VERSION}" \
    --notes "$RELEASE_NOTES"

echo "  Release: https://github.com/${GITHUB_REPO}/releases/tag/${TAG}"

# Step 6: Generate appcast and fix download URL
log_step "Generating appcast..."
"$SPARKLE_TOOLS/bin/generate_appcast" "$RELEASES_DIR"

if [ -f "$RELEASES_DIR/appcast.xml" ]; then
    cp "$RELEASES_DIR/appcast.xml" "$SCRIPT_DIR/appcast.xml"
    # Replace local file URLs with GitHub release download URLs
    sed -i '' "s|url=\"[^\"]*${DMG_NAME}\"|url=\"${DOWNLOAD_URL}\"|g" "$SCRIPT_DIR/appcast.xml"
    echo "  Updated appcast.xml with download URL: $DOWNLOAD_URL"
else
    log_warn "generate_appcast did not produce appcast.xml"
fi

# Step 7: Commit and push appcast
log_step "Pushing appcast.xml..."
cd "$SCRIPT_DIR"
git add appcast.xml
git commit -m "Update appcast.xml for v${VERSION}" || true
git push

echo ""
echo -e "${GREEN}=========================================="
echo "  Release v${VERSION} published!"
echo "==========================================${NC}"
echo ""
echo "  GitHub: https://github.com/${GITHUB_REPO}/releases/tag/${TAG}"
echo "  Feed:   https://raw.githubusercontent.com/${GITHUB_REPO}/main/appcast.xml"
