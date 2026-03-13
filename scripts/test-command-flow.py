#!/usr/bin/env python3
"""
Test script to verify the user command flow from Dashboard -> Control Plane -> Sidecar -> Agent.
This simulates an agent that polls for commands and responds.
"""

import os
import sys
import time
import json
import requests

SIDECAR_URL = os.environ.get("PADDOCK_SIDECAR_URL", "http://localhost:8801")
COMMAND_FILE = os.environ.get("PADDOCK_COMMAND_FILE", "/tmp/paddock-commands.jsonl")

def main():
    print(f"Test Agent starting...")
    print(f"Sidecar URL: {SIDECAR_URL}")
    print(f"Command file: {COMMAND_FILE}")

    # Report ready
    try:
        resp = requests.post(f"{SIDECAR_URL}/amp/agent/ready", json={"version": "test-1.0", "capabilities": ["test"]}, timeout=5)
        print(f"Reported ready: {resp.status_code}")
    except Exception as e:
        print(f"Failed to report ready: {e}")
        sys.exit(1)

    # Poll for commands
    offset = 0
    print("Polling for commands...")

    while True:
        try:
            if os.path.exists(COMMAND_FILE):
                with open(COMMAND_FILE, "r") as f:
                    lines = f.readlines()

                new_lines = lines[offset:]
                offset = len(lines)

                for line in new_lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        command = entry.get("command", "")
                        print(f"Received command: {command}")

                        # Simulate processing
                        response = f"Echo: {command}"
                        print(f"Responding: {response}")

                        # Report the response as an event
                        requests.post(
                            f"{SIDECAR_URL}/amp/event",
                            json={"toolName": "test.response", "result": response},
                            timeout=2
                        )
                    except json.JSONDecodeError:
                        pass
        except Exception as e:
            print(f"Error polling: {e}")

        time.sleep(1)

if __name__ == "__main__":
    main()
