#!/bin/bash
# Debug a running Paddock session from the host

if [ -z "$1" ]; then
    echo "Usage: $0 <session-id>"
    echo ""
    echo "This script will:"
    echo "  1. Get session info from Control Plane"
    echo "  2. Copy debug script to VM"
    echo "  3. Run debug script inside VM"
    echo "  4. Show results"
    exit 1
fi

SESSION_ID="$1"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:3100}"

echo "=== Debugging Paddock Session: $SESSION_ID ==="
echo ""

# Get session info
echo "1. Fetching session info..."
SESSION_INFO=$(curl -sf "$CONTROL_PLANE_URL/api/sessions/$SESSION_ID")
if [ $? -ne 0 ]; then
    echo "✗ Failed to fetch session info. Is Control Plane running?"
    exit 1
fi

VM_ID=$(echo "$SESSION_INFO" | jq -r '.vmId // empty')
SANDBOX_TYPE=$(echo "$SESSION_INFO" | jq -r '.sandboxType // empty')

if [ -z "$VM_ID" ]; then
    echo "✗ Session has no VM ID. Is the VM running?"
    exit 1
fi

echo "✓ Session found"
echo "  VM ID: $VM_ID"
echo "  Sandbox Type: $SANDBOX_TYPE"
echo ""

# Test command forwarding
echo "2. Testing command forwarding..."
TEST_CMD="debug-test-$(date +%s)"
curl -sf "$CONTROL_PLANE_URL/api/sessions/$SESSION_ID/command" \
    -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"$TEST_CMD\"}" > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "✓ Command API responded"
else
    echo "⚠ Command API failed (this might be expected if endpoint doesn't exist)"
fi

# Try WebSocket command (this is what Dashboard uses)
echo ""
echo "3. Sending test command via WebSocket simulation..."
echo "   (Dashboard sends: {type:'user.command', command:'...'} via WebSocket)"
echo ""

# Check events
echo "4. Checking recent events..."
EVENTS=$(curl -sf "$CONTROL_PLANE_URL/api/sessions/$SESSION_ID/events?limit=10")
echo "$EVENTS" | jq -r '.[] | "\(.timestamp) [\(.type)] \(.payload.message // .payload.command // "")"' | tail -5

echo ""
echo "5. To debug inside the VM, run:"
echo ""
echo "   # Copy debug script to VM"
echo "   boxlite cp $VM_ID scripts/debug-command-flow.sh /tmp/debug.sh"
echo ""
echo "   # Run debug script"
echo "   boxlite exec $VM_ID 'sh /tmp/debug.sh'"
echo ""
echo "   # Or manually check:"
echo "   boxlite exec $VM_ID 'cat /tmp/paddock-commands.jsonl'"
echo "   boxlite exec $VM_ID 'curl -X POST http://localhost:8801/amp/command -d \"{\\\"command\\\":\\\"test\\\"}\" -H \"Content-Type: application/json\"'"
echo ""
echo "6. To test agent integration:"
echo "   boxlite cp $VM_ID scripts/test-agent-integration.py /tmp/test-agent.py"
echo "   boxlite exec $VM_ID 'python3 /tmp/test-agent.py'"
echo ""
