#!/bin/bash
# Debug script to check command flow in VM

echo "=== Paddock Command Flow Debug ==="
echo ""

# Check if we're in a VM
if [ -f "/etc/paddock-vm" ]; then
    echo "✓ Running inside Paddock VM"
else
    echo "✗ Not in Paddock VM (this script should run inside the VM)"
    exit 1
fi

echo ""
echo "=== 1. Check Sidecar Status ==="
if pgrep -f "node.*index.js" > /dev/null || pgrep -f "paddock-sidecar" > /dev/null; then
    echo "✓ Sidecar is running"
    echo "  PID: $(pgrep -f 'node.*index.js' || pgrep -f 'paddock-sidecar')"
else
    echo "✗ Sidecar is NOT running"
fi

echo ""
echo "=== 2. Check Sidecar Ports ==="
if netstat -tuln 2>/dev/null | grep -q ":8800"; then
    echo "✓ Port 8800 (LLM Proxy) is listening"
else
    echo "✗ Port 8800 is NOT listening"
fi

if netstat -tuln 2>/dev/null | grep -q ":8801"; then
    echo "✓ Port 8801 (AMP Gate) is listening"
else
    echo "✗ Port 8801 is NOT listening"
fi

echo ""
echo "=== 3. Test Sidecar Command Endpoint ==="
response=$(curl -sf -X POST http://localhost:8801/amp/command \
    -H 'Content-Type: application/json' \
    -d '{"command":"debug test","timestamp":'$(date +%s)'}' 2>&1)
if [ $? -eq 0 ]; then
    echo "✓ Command endpoint is working"
    echo "  Response: $response"
else
    echo "✗ Command endpoint failed"
    echo "  Error: $response"
fi

echo ""
echo "=== 4. Check Command File ==="
if [ -f "/tmp/paddock-commands.jsonl" ]; then
    echo "✓ Command file exists: /tmp/paddock-commands.jsonl"
    line_count=$(wc -l < /tmp/paddock-commands.jsonl)
    echo "  Lines: $line_count"
    echo "  Last 3 commands:"
    tail -3 /tmp/paddock-commands.jsonl | while read line; do
        echo "    $line"
    done
else
    echo "✗ Command file does NOT exist"
fi

echo ""
echo "=== 5. Check OpenClaw Status ==="
if [ -d "/opt/openclaw" ]; then
    echo "✓ OpenClaw directory exists"
    if pgrep -f "openclaw" > /dev/null; then
        echo "✓ OpenClaw process is running"
        echo "  PID: $(pgrep -f 'openclaw')"
    else
        echo "✗ OpenClaw process is NOT running"
    fi

    if [ -f "/var/log/openclaw.log" ]; then
        echo ""
        echo "  Last 10 lines of OpenClaw log:"
        tail -10 /var/log/openclaw.log | sed 's/^/    /'
    fi
else
    echo "✗ OpenClaw directory does NOT exist (/opt/openclaw)"
    echo "  This is expected - OpenClaw repo doesn't exist on GitHub"
fi

echo ""
echo "=== 6. Check AMP Plugin Installation ==="
if python3 -c "import paddock_amp" 2>/dev/null; then
    echo "✓ paddock_amp Python package is installed"
    python3 -c "from paddock_amp import PaddockAMPPlugin; print('  Version:', PaddockAMPPlugin.__module__)"
else
    echo "✗ paddock_amp Python package is NOT installed"
fi

echo ""
echo "=== 7. Check Environment Variables ==="
echo "  PADDOCK_SIDECAR_URL: ${PADDOCK_SIDECAR_URL:-<not set>}"
echo "  PADDOCK_COMMAND_FILE: ${PADDOCK_COMMAND_FILE:-<not set, default: /tmp/paddock-commands.jsonl>}"
echo "  ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL:-<not set>}"
echo "  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-<not set>}"

echo ""
echo "=== 8. Sidecar Logs ==="
if [ -f "/var/log/paddock-sidecar.log" ]; then
    echo "  Last 15 lines:"
    tail -15 /var/log/paddock-sidecar.log | sed 's/^/    /'
else
    echo "  No sidecar log file found"
fi

echo ""
echo "=== Debug Complete ==="
