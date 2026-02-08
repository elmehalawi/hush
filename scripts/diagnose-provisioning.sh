#!/bin/bash
# Quick diagnostic script to test provisioning flow and capture the error

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUST_TEST_DIR="$PROJECT_DIR/rust/test-provisioning"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Signal Provisioning Diagnostic ===${NC}"
echo ""

# Check 1: Network connectivity to Signal servers
echo -e "${YELLOW}[1/4] Testing network connectivity to Signal servers...${NC}"
if curl -s --connect-timeout 5 https://chat.signal.org > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Signal server is reachable${NC}"
else
    echo -e "${RED}✗ Cannot reach Signal server - check your network${NC}"
    exit 1
fi

# Check 2: Check for stale data
echo -e "\n${YELLOW}[2/4] Checking for stale Signal data...${NC}"
DATA_DIR="/tmp/signal-app-data"
if [ -d "$DATA_DIR" ]; then
    echo "Found existing data directory: $DATA_DIR"
    ls -la "$DATA_DIR/" 2>/dev/null || true
    echo -e "\n${YELLOW}Removing stale data...${NC}"
    rm -rf "$DATA_DIR"
    echo -e "${GREEN}✓ Stale data removed${NC}"
else
    echo -e "${GREEN}✓ No stale data found${NC}"
fi

# Check 3: Build and run the Rust test
echo -e "\n${YELLOW}[3/4] Running Rust provisioning test...${NC}"
echo "This will test the actual provisioning flow."
echo "DO NOT scan the QR code - we want to see the timeout error."
echo ""

cd "$RUST_TEST_DIR"

# Build first
echo "Building test..."
if ! cargo build --release 2>&1 | grep -v "Compiling\|Finished\|Downloading\|Downloaded"; then
    echo -e "${RED}Build failed${NC}"
    exit 1
fi

echo -e "\n${GREEN}Build succeeded. Running test...${NC}"
echo "This will take ~90 seconds to timeout."
echo "Capturing timing to diagnose if the error occurs early..."
echo ""

# Run with timing
START_TIME=$(date +%s)

# Run the test and capture output
RUST_LOG=warn cargo run --release 2>&1 | while IFS= read -r line; do
    ELAPSED=$(($(date +%s) - START_TIME))
    echo "[${ELAPSED}s] $line"
done

END_TIME=$(date +%s)
TOTAL_TIME=$((END_TIME - START_TIME))

echo ""
echo -e "${BLUE}[4/4] Diagnostic Summary${NC}"
echo "========================================"
echo "Total time to error: ${TOTAL_TIME} seconds"
echo ""

if [ $TOTAL_TIME -lt 30 ]; then
    echo -e "${RED}ERROR occurred too quickly (< 30s)${NC}"
    echo "This suggests:"
    echo "  - Network/connectivity issue"
    echo "  - Signal server rejecting connection"
    echo "  - Firewall blocking WebSocket"
elif [ $TOTAL_TIME -lt 60 ]; then
    echo -e "${YELLOW}ERROR occurred after ${TOTAL_TIME}s (30-60s)${NC}"
    echo "This suggests:"
    echo "  - Possible WebSocket connection issues"
    echo "  - Server-side timeout"
else
    echo -e "${GREEN}ERROR occurred after ${TOTAL_TIME}s (normal timeout)${NC}"
    echo "This is the expected behavior when QR code is not scanned."
    echo "The provisioning flow is working correctly."
fi

echo ""
echo "========================================"
