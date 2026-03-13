#!/usr/bin/env python3
"""
Test script to verify agent integration with Paddock command polling.
This simulates what OpenClaw should do to receive commands.
"""

import sys
import time
import signal
from paddock_amp import PaddockAMPPlugin

def main():
    print("=== Paddock Agent Integration Test ===\n")

    # Initialize plugin
    plugin = PaddockAMPPlugin(agent_version="test-1.0.0")
    print(f"✓ Initialized PaddockAMPPlugin")
    print(f"  Sidecar URL: {plugin.sidecar_url}")
    print(f"  Command file: /tmp/paddock-commands.jsonl\n")

    # Report ready
    try:
        plugin.report_ready(capabilities=["test", "debug"])
        print("✓ Reported agent ready to Sidecar\n")
    except Exception as e:
        print(f"✗ Failed to report ready: {e}\n")

    # Register command callback
    command_count = 0
    def on_command(command: str):
        nonlocal command_count
        command_count += 1
        print(f"[{time.strftime('%H:%M:%S')}] Received command #{command_count}: {command}")

        # Simulate processing
        if command.lower() == "test":
            print("  → Processing test command...")
        elif command.lower() == "exit":
            print("  → Exit command received, stopping...")
            plugin.stop_command_polling()
            sys.exit(0)
        else:
            print(f"  → Unknown command, but received successfully")

    plugin.on_command(on_command)
    print("✓ Registered command callback\n")

    # Start polling
    print("Starting command polling (interval: 1.0s)...")
    print("Send commands from Dashboard or use:")
    print("  curl -X POST http://localhost:8801/amp/command -H 'Content-Type: application/json' -d '{\"command\":\"test\"}'")
    print("\nPress Ctrl+C to stop\n")

    plugin.start_command_polling(interval=1.0)

    # Handle Ctrl+C
    def signal_handler(sig, frame):
        print("\n\nStopping command polling...")
        plugin.stop_command_polling()
        print(f"Total commands received: {command_count}")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)

    # Keep running
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        signal_handler(None, None)

if __name__ == "__main__":
    main()
