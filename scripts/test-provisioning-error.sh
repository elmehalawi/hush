#!/bin/bash
# Test script to reproduce the "no provisioning message received" error
# This script starts the app and captures all relevant logs

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/test-logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Signal App Provisioning Error Test ===${NC}"
echo "Timestamp: $TIMESTAMP"
echo "Project dir: $PROJECT_DIR"

# Create log directory
mkdir -p "$LOG_DIR"

# Log files
METRO_LOG="$LOG_DIR/metro_$TIMESTAMP.log"
APP_LOG="$LOG_DIR/app_$TIMESTAMP.log"
RUST_LOG="$LOG_DIR/rust_$TIMESTAMP.log"
COMBINED_LOG="$LOG_DIR/combined_$TIMESTAMP.log"
ERROR_LOG="$LOG_DIR/errors_$TIMESTAMP.log"

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"

    # Kill Metro bundler if running
    if [ -n "$METRO_PID" ] && kill -0 "$METRO_PID" 2>/dev/null; then
        echo "Stopping Metro bundler (PID: $METRO_PID)"
        kill "$METRO_PID" 2>/dev/null || true
    fi

    # Kill any remaining Metro processes
    pkill -f "react-native start" 2>/dev/null || true
    pkill -f "metro" 2>/dev/null || true

    # Kill the app if running
    pkill -f "signal-app" 2>/dev/null || true

    echo -e "${GREEN}Cleanup complete${NC}"

    # Show summary
    echo -e "\n${BLUE}=== Test Summary ===${NC}"
    echo "Log files created:"
    echo "  - Metro log: $METRO_LOG"
    echo "  - App log: $APP_LOG"
    echo "  - Combined log: $COMBINED_LOG"
    echo "  - Error log: $ERROR_LOG"

    if [ -f "$ERROR_LOG" ] && [ -s "$ERROR_LOG" ]; then
        echo -e "\n${RED}=== Captured Errors ===${NC}"
        cat "$ERROR_LOG"
    fi
}

trap cleanup EXIT

# Clear old Signal data to force fresh linking
DATA_DIR="/tmp/signal-app-data"
echo -e "\n${YELLOW}Clearing old Signal data at $DATA_DIR...${NC}"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

# Change to project directory
cd "$PROJECT_DIR"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Start Metro bundler in background
echo -e "\n${BLUE}Starting Metro bundler...${NC}"
npm start > "$METRO_LOG" 2>&1 &
METRO_PID=$!
echo "Metro PID: $METRO_PID"

# Wait for Metro to be ready
echo "Waiting for Metro bundler to start..."
MAX_WAIT=60
WAITED=0
while ! grep -qE "Dev server ready|Metro waiting on" "$METRO_LOG" 2>/dev/null && [ $WAITED -lt $MAX_WAIT ]; do
    sleep 1
    WAITED=$((WAITED + 1))
    echo -n "."
done
echo ""

if [ $WAITED -ge $MAX_WAIT ]; then
    echo -e "${RED}Metro bundler failed to start within ${MAX_WAIT}s${NC}"
    cat "$METRO_LOG"
    exit 1
fi

echo -e "${GREEN}Metro bundler is ready${NC}"

# Build and run the macOS app
echo -e "\n${BLUE}Building and running macOS app...${NC}"
echo "This may take a while on first run..."

# Run the app and capture output
# We use xcodebuild directly for better log capture
cd macos

# Find the built app or build it
APP_PATH=""
BUILD_DIR="$PROJECT_DIR/macos/build/Build/Products/Debug"

if [ -d "$BUILD_DIR/signal-app.app" ]; then
    APP_PATH="$BUILD_DIR/signal-app.app"
    echo "Found existing build at $APP_PATH"
else
    echo "Building app with xcodebuild..."
    xcodebuild -workspace signal-app.xcworkspace \
        -scheme signal-app-macOS \
        -configuration Debug \
        -derivedDataPath build \
        build 2>&1 | tee "$LOG_DIR/build_$TIMESTAMP.log"

    APP_PATH="$BUILD_DIR/signal-app.app"
fi

if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}Failed to find or build app${NC}"
    exit 1
fi

echo -e "${GREEN}App built successfully${NC}"

# Run the app with logging
echo -e "\n${BLUE}Running app and capturing logs...${NC}"
echo "The app will display a QR code. DO NOT scan it to trigger the timeout error."
echo "Waiting for provisioning timeout (this may take 60-90 seconds)..."
echo ""

# Start capturing system logs for the app
log stream --predicate 'subsystem CONTAINS "signal-app" OR process CONTAINS "signal-app" OR eventMessage CONTAINS "PresageModule" OR eventMessage CONTAINS "RUST"' > "$APP_LOG" 2>&1 &
LOG_STREAM_PID=$!

# Also capture stderr from the app
export RUST_LOG=debug
export RUST_BACKTRACE=1

# Run the app in background
"$APP_PATH/Contents/MacOS/signal-app" > "$RUST_LOG" 2>&1 &
APP_PID=$!
echo "App PID: $APP_PID"

# Monitor for errors
echo -e "\n${YELLOW}Monitoring for provisioning errors...${NC}"
echo "Press Ctrl+C to stop early"
echo ""

# Combine logs and watch for errors
TIMEOUT=120
ELAPSED=0
ERROR_FOUND=false

while [ $ELAPSED -lt $TIMEOUT ] && kill -0 "$APP_PID" 2>/dev/null; do
    # Check for provisioning error patterns
    if grep -qi "provisioning" "$RUST_LOG" "$APP_LOG" 2>/dev/null; then
        grep -i "provisioning" "$RUST_LOG" "$APP_LOG" 2>/dev/null >> "$ERROR_LOG" || true
    fi

    if grep -qi "no provisioning message" "$RUST_LOG" "$APP_LOG" 2>/dev/null; then
        echo -e "\n${RED}FOUND: 'no provisioning message' error!${NC}"
        ERROR_FOUND=true
        grep -i "no provisioning message" "$RUST_LOG" "$APP_LOG" 2>/dev/null >> "$ERROR_LOG" || true
    fi

    if grep -qi "LinkingFailed\|linking failed\|InternalError" "$RUST_LOG" "$APP_LOG" 2>/dev/null; then
        echo -e "\n${RED}FOUND: Linking error!${NC}"
        grep -i "LinkingFailed\|linking failed\|InternalError" "$RUST_LOG" "$APP_LOG" 2>/dev/null >> "$ERROR_LOG" || true
    fi

    if grep -qi "timeout\|timed out" "$RUST_LOG" "$APP_LOG" 2>/dev/null; then
        grep -i "timeout\|timed out" "$RUST_LOG" "$APP_LOG" 2>/dev/null >> "$ERROR_LOG" || true
    fi

    # Show progress
    echo -ne "\rElapsed: ${ELAPSED}s / ${TIMEOUT}s"

    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

echo ""

# Kill log stream
kill "$LOG_STREAM_PID" 2>/dev/null || true

# Combine all logs
echo -e "\n${BLUE}Combining logs...${NC}"
{
    echo "=== METRO BUNDLER LOG ==="
    cat "$METRO_LOG" 2>/dev/null || echo "(empty)"
    echo ""
    echo "=== APP SYSTEM LOG ==="
    cat "$APP_LOG" 2>/dev/null || echo "(empty)"
    echo ""
    echo "=== RUST/APP STDERR LOG ==="
    cat "$RUST_LOG" 2>/dev/null || echo "(empty)"
} > "$COMBINED_LOG"

# Extract all errors
echo -e "\n${BLUE}Extracting errors...${NC}"
{
    echo "=== Extracted Errors from Test Run ==="
    echo "Timestamp: $TIMESTAMP"
    echo ""

    echo "--- Error patterns from RUST_LOG ---"
    grep -iE "error|fail|panic|provisioning|timeout|linking" "$RUST_LOG" 2>/dev/null || echo "(none)"
    echo ""

    echo "--- Error patterns from APP_LOG ---"
    grep -iE "error|fail|panic|provisioning|timeout|linking" "$APP_LOG" 2>/dev/null || echo "(none)"
    echo ""

    echo "--- PresageModule logs ---"
    grep -i "PresageModule" "$APP_LOG" "$RUST_LOG" 2>/dev/null || echo "(none)"
    echo ""

    echo "--- RUST logs ---"
    grep "\[RUST\]" "$RUST_LOG" 2>/dev/null || echo "(none)"
} >> "$ERROR_LOG"

if [ "$ERROR_FOUND" = true ]; then
    echo -e "\n${GREEN}Success: Provisioning error was captured!${NC}"
else
    echo -e "\n${YELLOW}Note: Provisioning error not detected in logs yet.${NC}"
    echo "Check the log files manually for more details."
fi

echo -e "\n${BLUE}Test complete. Check error log: $ERROR_LOG${NC}"
