"""
MCP Gateway client for accessing host-side capabilities.

Provides:
- MCP tool discovery
- MCP tool execution via sidecar
- Error handling and result parsing
"""

from __future__ import annotations

from typing import Any, Dict, List

import requests

from ..config import AgentConfig


class MCPError(Exception):
    """Raised when MCP tool operation fails."""
    pass


class MCPClient:
    """Client for interacting with MCP Gateway via sidecar."""

    def __init__(self, config: AgentConfig):
        """
        Initialize MCP client.

        Args:
            config: AgentConfig instance
        """
        self.config = config
        self.sidecar_url = config.sidecar_url
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})

    def list_tools(self) -> List[Dict[str, Any]]:
        """
        List available MCP tools from the gateway.

        Returns:
            List of tool definitions

        Raises:
            MCPError: If request fails
        """
        try:
            response = self.session.get(
                f"{self.sidecar_url}/mcp/tools",
                timeout=10,
            )
            response.raise_for_status()
            data = response.json()
            return data.get("tools", [])
        except Exception as e:
            raise MCPError(f"Failed to list MCP tools (sidecar unreachable): {e}")

    def call_tool(self, tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Call an MCP tool via the gateway.

        Args:
            tool_name: Name of the tool (e.g., "browser.open")
            args: Tool arguments

        Returns:
            Tool result with exitCode, stdout, stderr

        Raises:
            MCPError: If request fails
        """
        try:
            response = self.session.post(
                f"{self.sidecar_url}/mcp/call",
                json={
                    "toolName": tool_name,
                    "args": args,
                },
                timeout=30,
            )
            response.raise_for_status()
            return response.json()
        except requests.Timeout:
            raise MCPError(f"MCP tool call timeout: {tool_name}")
        except Exception as e:
            raise MCPError(f"MCP tool call failed: {e}")

    def get_tool_schema(self, tool_name: str) -> Dict[str, Any]:
        """
        Get schema for a specific MCP tool.

        Args:
            tool_name: Name of the tool

        Returns:
            Tool schema

        Raises:
            MCPError: If tool not found or request fails
        """
        tools = self.list_tools()
        for tool in tools:
            if tool.get("name") == tool_name:
                return tool

        raise MCPError(f"MCP tool not found: {tool_name}")

    # ── Convenience methods for common tools ──

    def browser_open(self, url: str) -> Dict[str, Any]:
        """
        Open a URL in the browser.

        Args:
            url: URL to open

        Returns:
            Tool result
        """
        return self.call_tool("browser.open", {"url": url})

    def clipboard_read(self) -> str:
        """
        Read clipboard contents.

        Returns:
            Clipboard text

        Raises:
            MCPError: If read fails
        """
        result = self.call_tool("clipboard.read", {})
        if result.get("exitCode") != 0:
            raise MCPError(f"Failed to read clipboard: {result.get('stderr', '')}")
        return result.get("stdout", "")

    def clipboard_write(self, text: str) -> Dict[str, Any]:
        """
        Write text to clipboard.

        Args:
            text: Text to write

        Returns:
            Tool result
        """
        return self.call_tool("clipboard.write", {"text": text})

    def tts_speak(self, text: str, voice: str = "default") -> Dict[str, Any]:
        """
        Speak text using text-to-speech.

        Args:
            text: Text to speak
            voice: Voice to use (default: "default")

        Returns:
            Tool result
        """
        return self.call_tool("tts.speak", {"text": text, "voice": voice})

    def applescript_run(self, script: str) -> Dict[str, Any]:
        """
        Run an AppleScript.

        Args:
            script: AppleScript code

        Returns:
            Tool result
        """
        return self.call_tool("applescript.run", {"script": script})
