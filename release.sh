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

# Signing config lives outside the repo so the certificate and notarization
# credentials never land in a public tree; see .signing.env.example.
if [ -f "$SCRIPT_DIR/.signing.env" ]; then
    source "$SCRIPT_DIR/.signing.env"
fi

if [ -z "$SIGN_IDENTITY" ] || [ "$SIGN_IDENTITY" = "-" ]; then
    log_error "SIGN_IDENTITY is not set, or is ad-hoc."
    echo "  Sparkle requires an update to carry the same code signature as the"
    echo "  installed app. Ad-hoc signatures pin that check to a per-build hash,"
    echo "  so every auto-update fails to install."
    echo "  Copy .signing.env.example to .signing.env and fill it in."
    exit 1
fi

if ! security find-identity -v -p codesigning | grep -qF "$SIGN_IDENTITY"; then
    log_error "Signing identity not in keychain: $SIGN_IDENTITY"
    echo "  Available identities:"
    security find-identity -v -p codesigning | sed 's/^/    /'
    exit 1
fi

# Notarization takes either a keychain profile or an App Store Connect API key.
# The API key avoids a keychain round-trip entirely, which matters on machines
# where the keychain can't be written non-interactively.
NOTARY_ARGS=()
if [ -n "$NOTARY_KEY" ]; then
    if [ ! -f "$NOTARY_KEY" ]; then
        log_error "NOTARY_KEY does not exist: $NOTARY_KEY"
        exit 1
    fi
    if [ -z "$NOTARY_KEY_ID" ] || [ -z "$NOTARY_ISSUER" ]; then
        log_error "NOTARY_KEY needs NOTARY_KEY_ID and NOTARY_ISSUER alongside it."
        exit 1
    fi
    NOTARY_ARGS=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
elif [ -n "$NOTARY_PROFILE" ]; then
    NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
else
    log_error "No notarization credentials configured."
    echo "  Set NOTARY_KEY / NOTARY_KEY_ID / NOTARY_ISSUER (App Store Connect API key),"
    echo "  or NOTARY_PROFILE for a stored keychain profile. See .signing.env.example."
    exit 1
fi

# notarytool only accepts archives, so the app is zipped for submission and the
# ticket is stapled back onto the original bundle.
notarize_app() {
    local app="$1"
    local zip
    zip=$(mktemp -d)/notarize.zip
    ditto -c -k --keepParent "$app" "$zip"
    xcrun notarytool submit "$zip" "${NOTARY_ARGS[@]}" --wait
    xcrun stapler staple "$app"
    rm -f "$zip"
}

# Step 1: Update version in Info.plist
log_step "Setting version to ${VERSION} (${BUILD})..."
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${BUILD}" "$INFO_PLIST"

# Step 2: Commit the version bump
log_step "Committing version bump..."
cd "$SCRIPT_DIR"
git add "$INFO_PLIST"
git commit -m "Bump version to ${VERSION} (build ${BUILD})"

# Step 3: Build the app in release mode
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

# Step 3.5: Notarize the app itself. Sparkle installs the app extracted from the
# DMG, so a ticket stapled only to the DMG would leave the installed copy having
# to phone home to Apple on first launch.
log_step "Notarizing app..."
notarize_app "$APP_PATH"

# Step 4: Create DMG
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

# Step 5: Notarize the DMG. This rewrites the file, so it has to finish before
# anything hashes or signs the DMG.
log_step "Notarizing DMG..."
xcrun notarytool submit "$DMG_PATH" "${NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$DMG_PATH"

log_step "Verifying Gatekeeper acceptance..."
spctl -a -vvv -t install "$DMG_PATH"

# Step 6: Create GitHub release (so we know the download URL for appcast)
log_step "Creating GitHub release..."
TAG="v${VERSION}"
GITHUB_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

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

# Step 7: Generate appcast. generate_appcast also writes this build's delta
# patches into releases/, so the prefix has to cover them too -- rewriting only
# the DMG URL is what left every delta pointing at a path that was never
# published, 404ing on each update.
log_step "Generating appcast..."
DOWNLOAD_PREFIX="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/"
"$SPARKLE_TOOLS/bin/generate_appcast" --download-url-prefix "$DOWNLOAD_PREFIX" "$RELEASES_DIR"

if [ ! -f "$RELEASES_DIR/appcast.xml" ]; then
    log_error "generate_appcast did not produce appcast.xml"
    exit 1
fi

# Upload this build's deltas under the same tag the prefix points at. Only the
# newest item is ever downloaded, so older items' URLs are cosmetic.
log_step "Uploading delta patches..."
DELTAS=("$RELEASES_DIR"/${APP_NAME}${BUILD}-*.delta)
if [ -e "${DELTAS[0]}" ]; then
    gh release upload "$TAG" "${DELTAS[@]}"
    echo "  Uploaded ${#DELTAS[@]} delta(s)"
else
    log_warn "No deltas generated for build ${BUILD}"
fi

cp "$RELEASES_DIR/appcast.xml" "$SCRIPT_DIR/appcast.xml"
echo "  Appcast enclosures point at: $DOWNLOAD_PREFIX"

# Step 8: Commit and push appcast
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
