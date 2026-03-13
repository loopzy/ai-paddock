"""
Unit tests for MCP Gateway client.

Tests cover:
- MCP tool discovery
- MCP tool execution via sidecar
- Tool result parsing
- Error handling
- Integration with ToolRegistry
"""

import json
import unittest
from unittest.mock import Mock, patch

from paddock_amp.tools.mcp_client import MCPClient, MCPError
from paddock_amp.config import AgentConfig


class TestMCPClient(unittest.TestCase):
    """Test suite for MCPClient."""

    def setUp(self):
        """Create test configuration."""
        import tempfile
        from pathlib import Path

        # Create temp workspace
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir) / "workspace"
        self.workspace.mkdir()

        self.config = AgentConfig(
            llm_provider="anthropic",
            agent_model="claude-3-5-haiku-latest",
            llm_base_url=None,
            llm_api_key=None,
            agent_max_tokens=256,
            agent_request_timeout_s=60,
            sidecar_url="http://localhost:8801",
            command_file="/tmp/test-commands.jsonl",
            workspace_root=str(self.workspace),
            max_file_size=1024 * 1024,
            exec_timeout=30,
        )

        self.client = MCPClient(self.config)

    def tearDown(self):
        """Clean up."""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # ── Tool Discovery ──

    @patch('requests.Session.get')
    def test_list_tools(self, mock_get):
        """Test listing available MCP tools."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "tools": [
                {
                    "name": "tts.speak",
                    "description": "Speak text on the host",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string", "description": "Text to speak"}
                        },
                        "required": ["text"]
                    }
                },
                {
                    "name": "clipboard.read",
                    "description": "Read clipboard contents",
                    "parameters": {"type": "object", "properties": {}}
                }
            ]
        }
        mock_get.return_value = mock_response

        tools = self.client.list_tools()

        self.assertEqual(len(tools), 2)
        self.assertEqual(tools[0]["name"], "tts.speak")
        self.assertEqual(tools[1]["name"], "clipboard.read")

    @patch('requests.Session.get')
    def test_list_tools_sidecar_unreachable(self, mock_get):
        """Test listing tools when sidecar is unreachable."""
        mock_get.side_effect = Exception("Connection refused")

        with self.assertRaises(MCPError) as ctx:
            self.client.list_tools()

        self.assertIn("unreachable", str(ctx.exception).lower())

    # ── Tool Execution ──

    @patch('requests.Session.post')
    def test_call_tool_success(self, mock_post):
        """Test calling an MCP tool successfully."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "exitCode": 0,
            "stdout": "Success"
        }
        mock_post.return_value = mock_response

        result = self.client.call_tool("browser.open", {"url": "https://example.com"})

        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["stdout"], "Success")

        # Verify request
        mock_post.assert_called_once()
        call_args = mock_post.call_args
        self.assertIn("/mcp/call", call_args[0][0])
        self.assertEqual(call_args[1]["json"]["toolName"], "browser.open")
        self.assertEqual(call_args[1]["json"]["args"], {"url": "https://example.com"})

    @patch('requests.Session.post')
    def test_call_tool_with_error(self, mock_post):
        """Test calling an MCP tool that returns an error."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "exitCode": 1,
            "stderr": "Tool execution failed"
        }
        mock_post.return_value = mock_response

        result = self.client.call_tool("browser.open", {"url": "invalid"})

        self.assertEqual(result["exitCode"], 1)
        self.assertIn("failed", result["stderr"])

    @patch('requests.Session.post')
    def test_call_tool_sidecar_error(self, mock_post):
        """Test calling tool when sidecar returns HTTP error."""
        mock_response = Mock()
        mock_response.status_code = 500
        mock_response.raise_for_status.side_effect = Exception("Internal Server Error")
        mock_post.return_value = mock_response

        with self.assertRaises(MCPError) as ctx:
            self.client.call_tool("browser.open", {"url": "https://example.com"})

        self.assertIn("failed", str(ctx.exception).lower())

    @patch('requests.Session.post')
    def test_call_tool_timeout(self, mock_post):
        """Test calling tool with timeout."""
        import requests
        mock_post.side_effect = requests.Timeout("Request timed out")

        with self.assertRaises(MCPError) as ctx:
            self.client.call_tool("browser.open", {"url": "https://example.com"})

        self.assertIn("timeout", str(ctx.exception).lower())

    # ── Specific Tool Tests ──

    @patch('requests.Session.post')
    def test_browser_open(self, mock_post):
        """Test browser.open tool."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"exitCode": 0}
        mock_post.return_value = mock_response

        result = self.client.call_tool("browser.open", {"url": "https://google.com"})

        self.assertEqual(result["exitCode"], 0)

    @patch('requests.Session.post')
    def test_clipboard_read(self, mock_post):
        """Test clipboard.read tool."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "exitCode": 0,
            "stdout": "clipboard content"
        }
        mock_post.return_value = mock_response

        result = self.client.call_tool("clipboard.read", {})

        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["stdout"], "clipboard content")

    @patch('requests.Session.post')
    def test_clipboard_write(self, mock_post):
        """Test clipboard.write tool."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"exitCode": 0}
        mock_post.return_value = mock_response

        result = self.client.call_tool("clipboard.write", {"text": "test content"})

        self.assertEqual(result["exitCode"], 0)

    # ── Tool Registry Integration ──

    @patch('requests.Session.get')
    def test_register_mcp_tools_in_registry(self, mock_get):
        """Test registering MCP tools in ToolRegistry."""
        from paddock_amp.plugin import PaddockAMPPlugin
        from paddock_amp.tools.tool_registry import ToolRegistry

        # Mock MCP tool list
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "tools": [
                {
                    "name": "tts.speak",
                    "description": "Speak text",
                    "parameters": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                        "required": ["text"]
                    }
                }
            ]
        }
        mock_get.return_value = mock_response

        plugin = PaddockAMPPlugin(config=self.config)
        registry = ToolRegistry(plugin, self.config)

        # Register MCP tools
        registry.register_mcp_tools()

        # Verify tool is registered
        tool = registry.get_tool("tts.speak")
        self.assertIsNotNone(tool)
        self.assertEqual(tool.name, "tts.speak")

    @patch('requests.Session.get')
    def test_register_mcp_tools_skips_sandbox_local_names(self, mock_get):
        """Test that MCP registration only keeps external-boundary tools."""
        from paddock_amp.plugin import PaddockAMPPlugin
        from paddock_amp.tools.tool_registry import ToolRegistry

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "tools": [
                {
                    "name": "browser.open",
                    "description": "Open a URL",
                    "parameters": {
                        "type": "object",
                        "properties": {"url": {"type": "string"}},
                        "required": ["url"]
                    }
                },
                {
                    "name": "read",
                    "description": "Read a file",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"]
                    }
                }
            ]
        }
        mock_get.return_value = mock_response

        plugin = PaddockAMPPlugin(config=self.config)
        registry = ToolRegistry(plugin, self.config)

        registry.register_mcp_tools()

        self.assertIsNone(registry.get_tool("browser.open"))
        self.assertIsNone(registry.get_tool("browser"))
        self.assertIsNone(registry.get_tool("read"))

    @patch('requests.Session.post')
    @patch('requests.Session.get')
    def test_execute_mcp_tool_via_registry(self, mock_get, mock_post):
        """Test executing MCP tool via ToolRegistry."""
        from paddock_amp.plugin import PaddockAMPPlugin
        from paddock_amp.tools.tool_registry import ToolRegistry

        # Mock tool list
        list_response = Mock()
        list_response.status_code = 200
        list_response.json.return_value = {
            "tools": [{
                "name": "tts.speak",
                "description": "Speak text",
                "parameters": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"]
                }
            }]
        }
        mock_get.return_value = list_response

        # Mock AMP tool intent, gate approval, MCP tool execution, and result report
        intent_response = Mock()
        intent_response.status_code = 200

        gate_response = Mock()
        gate_response.status_code = 200
        gate_response.json.return_value = {"verdict": "approve"}

        tool_response = Mock()
        tool_response.status_code = 200
        tool_response.json.return_value = {"exitCode": 0, "stdout": "Opened"}

        result_response = Mock()
        result_response.status_code = 200

        mock_post.side_effect = [
            intent_response,
            gate_response,
            tool_response,
            result_response,
        ]

        plugin = PaddockAMPPlugin(config=self.config)
        registry = ToolRegistry(plugin, self.config)
        registry.register_mcp_tools()

        # Execute tool
        result = registry.execute_tool("tts.speak", {"text": "hello"})

        self.assertEqual(result["exitCode"], 0)

    @patch('requests.Session.get')
    def test_register_mcp_tools_keeps_tts_when_browser_is_present(self, mock_get):
        """Test that browser host tools are excluded while real external tools remain."""
        from paddock_amp.plugin import PaddockAMPPlugin
        from paddock_amp.tools.tool_registry import ToolRegistry

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "tools": [
                {
                    "name": "browser.open",
                    "description": "Open in host browser",
                    "parameters": {
                        "type": "object",
                        "properties": {"url": {"type": "string"}},
                        "required": ["url"],
                    },
                },
                {
                    "name": "tts.speak",
                    "description": "Speak text",
                    "parameters": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                        "required": ["text"],
                    },
                },
            ]
        }
        mock_get.return_value = mock_response

        plugin = PaddockAMPPlugin(config=self.config)
        registry = ToolRegistry(plugin, self.config)
        registry.register_mcp_tools()

        self.assertIsNone(registry.get_tool("browser.open"))
        self.assertIsNotNone(registry.get_tool("tts.speak"))


if __name__ == "__main__":
    unittest.main()
