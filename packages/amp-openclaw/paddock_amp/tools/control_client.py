"""
Control-plane client for orchestration tools.

Routes OpenClaw-style session/subagent/rollback requests through the Sidecar's
amp/control boundary so the sandbox agent never talks to the control plane
directly.
"""

from __future__ import annotations

from typing import Any, Dict

import requests

from ..config import AgentConfig


class ControlPlaneError(Exception):
    """Raised when the control-plane boundary request fails."""


class ControlPlaneClient:
    """Client for invoking control-plane-routed tools via the Sidecar."""

    def __init__(self, config: AgentConfig):
        self.config = config
        self.sidecar_url = config.sidecar_url
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})

    def call_tool(self, tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            response = self.session.post(
                f"{self.sidecar_url}/amp/control",
                json={"toolName": tool_name, "args": args},
                timeout=30,
            )
            response.raise_for_status()
            return response.json()
        except requests.Timeout as exc:
            raise ControlPlaneError(f"Control-plane tool call timeout: {tool_name}") from exc
        except Exception as exc:
            raise ControlPlaneError(f"Control-plane tool call failed: {exc}") from exc
