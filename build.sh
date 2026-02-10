#!/bin/bash
set -e

# Build script for Hush
# Ensures Rust library, Swift bindings, and Xcode build are all in sync

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$SCRIPT_DIR/rust/presage-rn"
MACOS_DIR="$SCRIPT_DIR/macos"
GENERATED_DIR="$MACOS_DIR/Generated"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_step() {
    echo -e "${BLUE}==>${NC} ${GREEN}$1${NC}"
}

log_warn() {
    echo -e "${YELLOW}Warning:${NC} $1"
}

log_error() {
    echo -e "${RED}Error:${NC} $1"
}

# Parse arguments
CLEAN=false
RUN=false
RELEASE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --clean)
            CLEAN=true
            shift
            ;;
        --run)
            RUN=true
            shift
            ;;
        --release)
            RELEASE=true
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  --clean    Clean all build artifacts before building"
            echo "  --run      Run the app after building"
            echo "  --release  Build in release mode (default: debug)"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Determine build configuration
if [ "$RELEASE" = true ]; then
    RUST_PROFILE="release"
    RUST_FLAGS="--release"
    XCODE_CONFIG="Release"
else
    RUST_PROFILE="release"  # Always use release for Rust (debug is too slow)
    RUST_FLAGS="--release"
    XCODE_CONFIG="Debug"
fi

RUST_TARGET="aarch64-apple-darwin"
DYLIB_PATH="$RUST_DIR/target/$RUST_TARGET/$RUST_PROFILE/libpresage_rn.dylib"

echo ""
echo "=========================================="
echo "  Hush App Build Script"
echo "=========================================="
echo ""

# Step 0: Clean if requested
if [ "$CLEAN" = true ]; then
    log_step "Cleaning build artifacts..."

    # Clean Rust
    cd "$RUST_DIR"
    cargo clean 2>/dev/null || true

    # Clean Xcode derived data for this project
    rm -rf ~/Library/Developer/Xcode/DerivedData/signal-app-* 2>/dev/null || true

    # Clean generated bindings
    rm -rf "$GENERATED_DIR" 2>/dev/null || true
    mkdir -p "$GENERATED_DIR"

    # Clean CocoaPods cache
    cd "$MACOS_DIR"
    rm -rf Pods 2>/dev/null || true
    rm -f Podfile.lock 2>/dev/null || true

    echo "  Cleaned!"
fi

# Step 1: Build Rust library
log_step "Building Rust library ($RUST_PROFILE, $RUST_TARGET)..."
cd "$RUST_DIR"

# Ensure target is available
rustup target add "$RUST_TARGET" 2>/dev/null || true

cargo build $RUST_FLAGS --target "$RUST_TARGET"

if [ ! -f "$DYLIB_PATH" ]; then
    log_error "Rust build failed - dylib not found at $DYLIB_PATH"
    exit 1
fi

echo "  Built: $DYLIB_PATH"

# Step 2: Generate Swift bindings from the built library
log_step "Generating Swift bindings..."
mkdir -p "$GENERATED_DIR"

cargo run --bin uniffi-bindgen generate \
    --library "$DYLIB_PATH" \
    --language swift \
    --out-dir "$GENERATED_DIR"

# Also copy to the root for any other consumers
cp "$GENERATED_DIR/presage_rn.swift" "$SCRIPT_DIR/presage_rn.swift"
cp "$GENERATED_DIR/presage_rn.swift" "$SCRIPT_DIR/rust/macos/Generated/presage_rn.swift" 2>/dev/null || true

echo "  Generated: $GENERATED_DIR/presage_rn.swift"

# Step 2.5: Copy the static library to the Generated directory for Xcode linking
log_step "Copying static library for Xcode linking..."
STATIC_LIB="$RUST_DIR/target/$RUST_TARGET/$RUST_PROFILE/libpresage_rn.a"

if [ -f "$STATIC_LIB" ]; then
    cp "$STATIC_LIB" "$GENERATED_DIR/"
    echo "  Copied: $GENERATED_DIR/libpresage_rn.a"
else
    log_error "Static library not found at $STATIC_LIB"
    exit 1
fi

# Step 3: Install CocoaPods if needed
log_step "Checking CocoaPods..."
cd "$MACOS_DIR"

if [ ! -d "Pods" ] || [ "$CLEAN" = true ]; then
    log_step "Installing CocoaPods dependencies..."
    pod install
fi

# Step 4: Build Xcode project
log_step "Building Xcode project ($XCODE_CONFIG)..."
cd "$MACOS_DIR"

# Use xcworkspace if it exists (CocoaPods), otherwise xcodeproj
if [ -d "signal-app.xcworkspace" ]; then
    XCODE_PROJECT="-workspace signal-app.xcworkspace"
else
    XCODE_PROJECT="-project signal-app.xcodeproj"
fi

xcodebuild \
    $XCODE_PROJECT \
    -scheme signal-app-macOS \
    -configuration "$XCODE_CONFIG" \
    -destination "platform=macOS" \
    ARCHS=arm64 \
    ONLY_ACTIVE_ARCH=NO \
    build \
    | grep -E "^(Build|Compile|Link|error:|warning:.*error|===)" || true

# Check if build succeeded
BUILD_DIR="$HOME/Library/Developer/Xcode/DerivedData"
APP_PATH=$(find "$BUILD_DIR" -name "Hush.app" -path "*signal-app-*" -path "*$XCODE_CONFIG*" 2>/dev/null | head -1)

if [ -z "$APP_PATH" ]; then
    # Try the local build directory
    APP_PATH="$MACOS_DIR/build/Build/Products/$XCODE_CONFIG/Hush.app"
fi

if [ ! -d "$APP_PATH" ]; then
    log_error "Build failed - app not found"
    exit 1
fi

# Step 4.5: Compile app icon (.icon -> Assets.car + .icns)
ICON_FILE="$MACOS_DIR/signal-app-macOS/HushIcon.icon"
if [ -d "$ICON_FILE" ]; then
    log_step "Compiling app icon..."
    ICON_OUT=$(mktemp -d)
    xcrun actool "$ICON_FILE" \
        --compile "$ICON_OUT" \
        --output-format human-readable-text --notices --warnings --errors \
        --output-partial-info-plist "$ICON_OUT/partial.plist" \
        --app-icon HushIcon --include-all-app-icons \
        --enable-on-demand-resources NO \
        --development-region en \
        --target-device mac \
        --minimum-deployment-target 26.0 \
        --platform macosx
    cp "$ICON_OUT/Assets.car" "$APP_PATH/Contents/Resources/Assets.car" 2>/dev/null || true
    cp "$ICON_OUT/HushIcon.icns" "$APP_PATH/Contents/Resources/HushIcon.icns" 2>/dev/null || true
    rm -rf "$ICON_OUT"
    # Remove the raw .icon folder if it was copied by the build
    rm -rf "$APP_PATH/Contents/Resources/HushIcon.icon" 2>/dev/null || true
    echo "  App icon compiled and installed"

    # Re-sign after modifying the bundle (ad-hoc)
    codesign --force --deep --sign - "$APP_PATH"
    echo "  Re-signed app bundle"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "  Build Successful!"
echo "==========================================${NC}"
echo ""
echo "App location: $APP_PATH"
echo ""

# Step 5: Run if requested
if [ "$RUN" = true ]; then
    log_step "Launching app..."

    # Kill any existing instance
    pkill -f "Hush.app" 2>/dev/null || true
    sleep 1

    # Start Metro bundler in background if not running
    if ! pgrep -f "react-native start" > /dev/null; then
        log_step "Starting Metro bundler..."
        cd "$SCRIPT_DIR"
        npm run start &
        METRO_PID=$!
        sleep 3
    fi

    # Open the app
    open "$APP_PATH"

    echo ""
    echo -e "${GREEN}App launched!${NC}"
    echo "Check Console.app for logs (filter by 'Hush')"
fi
