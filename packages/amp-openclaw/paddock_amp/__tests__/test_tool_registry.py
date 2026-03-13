"""
Unit tests for tool integration with AMP Gate.

Tests cover:
- Tool registration and discovery
- Tool call interception and approval flow
- Input modification by security engine
- Tool result reporting
- Error handling and fail-closed behavior
- Integration with FileTools and BashTools
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, Mock
from typing import Any, Dict

from paddock_amp.plugin import PaddockAMPPlugin, ToolBlockedError
from paddock_amp.tools.tool_registry import ToolRegistry, ToolDefinition
from paddock_amp.tools.file_tools import FileTools
from paddock_amp.tools.bash_tools import BashTools
from paddock_amp.config import AgentConfig


class TestToolRegistry(unittest.TestCase):
    """Test suite for ToolRegistry."""

    def setUp(self):
        """Create test configuration."""
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

        self.plugin = PaddockAMPPlugin(config=self.config)
        self.registry = ToolRegistry(self.plugin, self.config)

    def tearDown(self):
        """Clean up."""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # ── Tool Registration ──

    def test_register_file_tools(self):
        """Test registering file operation tools."""
        self.registry.register_file_tools()

        tools = self.registry.get_all_tools()
        tool_names = [t.name for t in tools]

        self.assertIn("read", tool_names)
        self.assertIn("write", tool_names)
        self.assertIn("edit", tool_names)
        self.assertIn("list", tool_names)
        self.assertIn("read_file", tool_names)
        self.assertIn("write_file", tool_names)
        self.assertIn("edit_file", tool_names)
        self.assertIn("list_directory", tool_names)

    def test_register_bash_tools(self):
        """Test registering bash execution tools."""
        self.registry.register_bash_tools()

        tools = self.registry.get_all_tools()
        tool_names = [t.name for t in tools]

        self.assertIn("exec", tool_names)
        self.assertIn("bash_exec", tool_names)

    def test_register_browser_tools(self):
        """Test registering sandbox-local browser tools."""
        self.registry.register_browser_tools()

        tools = self.registry.get_all_tools()
        tool_names = [t.name for t in tools]

        self.assertIn("browser", tool_names)

    def test_get_tool_schemas_only_exposes_primary_openclaw_names(self):
        """Test that LLM-facing schemas prefer native OpenClaw tool names."""
        self.registry.register_file_tools()
        self.registry.register_bash_tools()

        schemas = self.registry.get_tool_schemas()
        schema_names = [schema["name"] for schema in schemas]

        self.assertIn("read", schema_names)
        self.assertIn("write", schema_names)
        self.assertIn("edit", schema_names)
        self.assertIn("list", schema_names)
        self.assertIn("apply_patch", schema_names)
        self.assertIn("exec", schema_names)
        self.assertNotIn("browser.open", schema_names)
        self.assertNotIn("read_file", schema_names)
        self.assertNotIn("write_file", schema_names)
        self.assertNotIn("edit_file", schema_names)
        self.assertNotIn("list_directory", schema_names)
        self.assertNotIn("bash_exec", schema_names)

    def test_browser_schema_is_exposed_to_llm(self):
        """Test that browser uses the OpenClaw-compatible local tool name."""
        self.registry.register_browser_tools()

        schemas = self.registry.get_tool_schemas()
        browser_schema = next(schema for schema in schemas if schema["name"] == "browser")

        self.assertIn("action", browser_schema["input_schema"]["properties"])
        self.assertIn("target", browser_schema["input_schema"]["properties"])
        self.assertIn("request", browser_schema["input_schema"]["properties"])

    def test_register_control_tools(self):
        """Test registering control-plane-routed orchestration tools."""
        self.registry.register_control_tools()

        tools = self.registry.get_all_tools()
        tool_names = [t.name for t in tools]

        self.assertIn("sessions_list", tool_names)
        self.assertIn("sessions_history", tool_names)
        self.assertIn("sessions_send", tool_names)
        self.assertIn("sessions_spawn", tool_names)
        self.assertIn("sessions_yield", tool_names)
        self.assertIn("session_status", tool_names)
        self.assertIn("subagents", tool_names)
        self.assertIn("cron", tool_names)
        self.assertIn("rollback", tool_names)

    def test_get_tool_by_name(self):
        """Test retrieving tool by name."""
        self.registry.register_file_tools()

        tool = self.registry.get_tool("read_file")

        self.assertIsNotNone(tool)
        self.assertEqual(tool.name, "read_file")
        self.assertIsNotNone(tool.description)
        self.assertIsNotNone(tool.parameters)

    def test_get_nonexistent_tool_returns_none(self):
        """Test that getting nonexistent tool returns None."""
        tool = self.registry.get_tool("nonexistent_tool")

        self.assertIsNone(tool)

    def test_list_all_tools(self):
        """Test listing all registered tools."""
        self.registry.register_file_tools()
        self.registry.register_bash_tools()

        tools = self.registry.get_all_tools()

        self.assertGreater(len(tools), 0)
        for tool in tools:
            self.assertIsInstance(tool, ToolDefinition)
            self.assertTrue(tool.name)
            self.assertTrue(tool.description)

    # ── Tool Execution with AMP Gate ──

    @patch('requests.Session.post')
    def test_execute_tool_with_approval(self, mock_post):
        """Test executing tool with AMP Gate approval."""
        # Mock AMP Gate approval
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"verdict": "approve"}
        mock_post.return_value = mock_response

        self.registry.register_file_tools()

        # Create a test file
        test_file = self.workspace / "test.txt"
        test_file.write_text("test content")

        # Execute read_file tool
        result = self.registry.execute_tool("read_file", {"path": "test.txt"})

        self.assertIn("content", result)
        self.assertEqual(result["content"], "test content")

        # Verify AMP Gate was called
        mock_post.assert_called()
        called_urls = [call.args[0] for call in mock_post.call_args_list]
        self.assertTrue(any("/amp/gate" in url for url in called_urls))
        self.assertIn("/amp/event", called_urls[0])
        self.assertIn("/amp/gate", called_urls[1])

    @patch('requests.Session.post')
    def test_execute_tool_with_rejection(self, mock_post):
        """Test executing tool with AMP Gate rejection."""
        # Mock AMP Gate rejection
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "verdict": "reject",
            "reason": "Suspicious file access"
        }
        mock_post.return_value = mock_response

        self.registry.register_file_tools()

        # Attempt to execute read_file tool
        with self.assertRaises(ToolBlockedError) as ctx:
            self.registry.execute_tool("read_file", {"path": "test.txt"})

        self.assertIn("Suspicious file access", str(ctx.exception))

    @patch('requests.Session.post')
    def test_execute_tool_with_input_modification(self, mock_post):
        """Test executing tool with AMP Gate modifying input."""
        # Mock AMP Gate modifying input
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "verdict": "modify",
            "modifiedInput": {"path": "sanitized.txt"}
        }
        mock_post.return_value = mock_response

        self.registry.register_file_tools()

        # Create sanitized file
        sanitized_file = self.workspace / "sanitized.txt"
        sanitized_file.write_text("sanitized content")

        # Execute with original input
        result = self.registry.execute_tool("read_file", {"path": "dangerous.txt"})

        # Should read sanitized file instead
        self.assertEqual(result["content"], "sanitized content")

    @patch.object(PaddockAMPPlugin, 'before_tool_call')
    def test_execute_tool_sidecar_unreachable_fails_closed(self, mock_before_tool_call):
        """Test that tool execution fails closed when sidecar is unreachable."""
        # Mock sidecar unreachable
        mock_before_tool_call.side_effect = ToolBlockedError("Paddock sidecar unreachable")

        self.registry.register_file_tools()

        # Attempt to execute tool
        with self.assertRaises(ToolBlockedError) as ctx:
            self.registry.execute_tool("read_file", {"path": "test.txt"})

        self.assertIn("unreachable", str(ctx.exception).lower())

    # ── Tool Result Reporting ──

    @patch('requests.Session.post')
    def test_tool_result_reported_to_sidecar(self, mock_post):
        """Test that tool results are reported to sidecar."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"verdict": "approve"}
        mock_post.return_value = mock_response

        self.registry.register_file_tools()

        # Create test file
        test_file = self.workspace / "test.txt"
        test_file.write_text("test content")

        # Execute tool
        self.registry.execute_tool("read_file", {"path": "test.txt"})

        # Verify event was reported
        self.assertEqual(mock_post.call_count, 3)
        intent_call = mock_post.call_args_list[0]
        gate_call = mock_post.call_args_list[1]
        result_call = mock_post.call_args_list[2]
        self.assertIn("/amp/event", intent_call.args[0])
        self.assertIn("/amp/gate", gate_call.args[0])
        self.assertIn("/amp/event", result_call.args[0])

    # ── Tool Parameter Validation ──

    @patch('requests.Session.post')
    def test_execute_tool_validates_required_parameters(self, mock_post):
        """Test that missing required parameters raise error."""
        self.registry.register_file_tools()

        with self.assertRaises(ValueError) as ctx:
            self.registry.execute_tool("read_file", {})  # Missing 'path'

        self.assertIn("required", str(ctx.exception).lower())

    def test_execute_nonexistent_tool_raises_error(self):
        """Test that executing nonexistent tool raises error."""
        with self.assertRaises(ValueError) as ctx:
            self.registry.execute_tool("nonexistent_tool", {})

        self.assertIn("not found", str(ctx.exception).lower())

    # ── Integration Tests ──

    @patch('requests.Session.post')
    def test_file_read_write_integration(self, mock_post):
        """Test file read/write integration with AMP Gate."""
        # Mock all approvals
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"verdict": "approve"}
        mock_post.return_value = mock_response

        self.registry.register_file_tools()

        # Write file
        write_result = self.registry.execute_tool(
            "write_file",
            {"path": "test.txt", "content": "Hello, World!"}
        )
        self.assertIn("path", write_result)

        # Read file
        read_result = self.registry.execute_tool("read_file", {"path": "test.txt"})
        self.assertEqual(read_result["content"], "Hello, World!")

    @patch('requests.Session.post')
    def test_bash_exec_integration(self, mock_post):
        """Test bash execution integration with AMP Gate."""
        # Mock approval
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"verdict": "approve"}
        mock_post.return_value = mock_response

        self.registry.register_bash_tools()

        # Execute command
        result = self.registry.execute_tool("bash_exec", {"command": "echo 'test'"})

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("test", result["stdout"])

    @patch('requests.Session.post')
    def test_tool_chain_with_multiple_approvals(self, mock_post):
        """Test chaining multiple tools with AMP Gate approvals."""
        # Mock all approvals
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"verdict": "approve"}
        mock_post.return_value = mock_response

        self.registry.register_file_tools()
        self.registry.register_bash_tools()

        # 1. Write file
        self.registry.execute_tool(
            "write_file",
            {"path": "script.sh", "content": "#!/bin/bash\necho 'executed'"}
        )

        # 2. Execute script
        result = self.registry.execute_tool(
            "bash_exec",
            {"command": "bash script.sh"}
        )

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("executed", result["stdout"])


if __name__ == "__main__":
    unittest.main()
