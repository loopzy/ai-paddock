import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

from paddock_amp.plugin import PaddockAMPPlugin
from paddock_amp.config import AgentConfig


class PaddockAMPPluginTests(unittest.TestCase):
    def setUp(self) -> None:
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        self.command_file = path

        # Create a config with our test command file
        self.test_config = AgentConfig(
            llm_provider="anthropic",
            agent_model="claude-3-5-haiku-latest",
            llm_base_url=None,
            llm_api_key=None,
            agent_max_tokens=256,
            agent_request_timeout_s=60,
            sidecar_url="http://localhost:8801",
            command_file=path,
            workspace_root="/workspace",
            max_file_size=10 * 1024 * 1024,
            exec_timeout=30,
        )

    def tearDown(self) -> None:
        if os.path.exists(self.command_file):
            os.unlink(self.command_file)

    def test_get_pending_commands_empty_file(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)
        self.assertEqual(plugin.get_pending_commands(), [])

    def test_get_pending_commands_single_command(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)

        with open(self.command_file, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "hello world", "timestamp": 123456}) + "\n")

        self.assertEqual(plugin.get_pending_commands(), ["hello world"])

    def test_get_pending_commands_multiple_commands(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)

        with open(self.command_file, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "cmd1", "timestamp": 1}) + "\n")
            handle.write(json.dumps({"command": "cmd2", "timestamp": 2}) + "\n")
            handle.write(json.dumps({"command": "cmd3", "timestamp": 3}) + "\n")

        self.assertEqual(plugin.get_pending_commands(), ["cmd1", "cmd2", "cmd3"])

    def test_get_pending_commands_incremental(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)

        with open(self.command_file, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "cmd1", "timestamp": 1}) + "\n")
            handle.write(json.dumps({"command": "cmd2", "timestamp": 2}) + "\n")

        self.assertEqual(plugin.get_pending_commands(), ["cmd1", "cmd2"])

        with open(self.command_file, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "cmd3", "timestamp": 3}) + "\n")

        self.assertEqual(plugin.get_pending_commands(), ["cmd3"])
        self.assertEqual(plugin.get_pending_commands(), [])

    def test_get_pending_commands_special_characters(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)
        special_command = 'echo "hello\'s world" && ls -la'

        with open(self.command_file, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": special_command, "timestamp": 1}) + "\n")

        self.assertEqual(plugin.get_pending_commands(), [special_command])

    def test_get_pending_commands_malformed_json(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)

        with open(self.command_file, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "cmd1", "timestamp": 1}) + "\n")
            handle.write("this is not json\n")
            handle.write(json.dumps({"command": "cmd2", "timestamp": 2}) + "\n")

        self.assertEqual(plugin.get_pending_commands(), ["cmd1", "cmd2"])

    def test_on_command_callback(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)
        received_commands = []

        plugin.on_command(received_commands.append)

        with open(self.command_file, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "test1", "timestamp": 1}) + "\n")
            handle.write(json.dumps({"command": "test2", "timestamp": 2}) + "\n")

        for command in plugin.get_pending_commands():
            for callback in plugin._command_callbacks:
                callback(command)

        self.assertEqual(received_commands, ["test1", "test2"])

    def test_count_existing_lines(self) -> None:
        with open(self.command_file, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "old1", "timestamp": 1}) + "\n")
            handle.write(json.dumps({"command": "old2", "timestamp": 2}) + "\n")

        plugin = PaddockAMPPlugin(config=self.test_config)
        offset = plugin._count_existing_lines()
        self.assertEqual(offset, 2)

        with open(self.command_file, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": "new1", "timestamp": 3}) + "\n")

        plugin._command_offset = offset
        self.assertEqual(plugin.get_pending_commands(), ["new1"])

    def test_llm_output_reports_auth_errors(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)
        plugin.report_error = MagicMock()
        plugin._report = MagicMock()

        response = {
            "status": 401,
            "model": "claude-3-5-haiku-latest",
            "error": "API key not configured. Set ANTHROPIC_API_KEY.",
        }

        returned = plugin.llm_output(response)

        self.assertIs(returned, response)
        plugin.report_error.assert_called_once_with(
            category="auth",
            code="ERR_NO_API_KEY",
            message="API key not configured. Set ANTHROPIC_API_KEY.",
            recoverable=False,
            context={"model": "claude-3-5-haiku-latest", "status": 401},
        )
        plugin._report.assert_not_called()

    def test_llm_output_reports_success_events(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)
        plugin.report_error = MagicMock()
        plugin._report = MagicMock()

        response = {
            "status": 200,
            "model": "claude-3-5-haiku-latest",
            "content": [{"type": "text", "text": "hello"}],
        }

        plugin.llm_output(response)

        plugin.report_error.assert_not_called()
        plugin._report.assert_called_once_with(
            "amp.llm.response",
            {"model": "claude-3-5-haiku-latest"},
        )

    def test_llm_output_reports_wrapped_rate_limit_errors(self) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)
        plugin.report_error = MagicMock()
        plugin._report = MagicMock()

        response = {
            "status": 503,
            "code": 429,
            "model": "claude-3-5-haiku-latest",
            "msg": "请求过于频繁，请稍后再试",
        }

        returned = plugin.llm_output(response)

        self.assertIs(returned, response)
        plugin.report_error.assert_called_once_with(
            category="resource",
            code="ERR_RATE_LIMIT",
            message="请求过于频繁，请稍后再试",
            recoverable=True,
            context={"model": "claude-3-5-haiku-latest", "status": 503},
        )
        plugin._report.assert_not_called()

    @patch("requests.Session.post")
    def test_before_tool_call_attaches_correlation_and_snapshot_metadata(self, mock_post) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)

        intent_response = Mock(status_code=200)
        gate_response = Mock(status_code=200)
        gate_response.json.return_value = {
            "verdict": "approve",
            "snapshotRef": "snap-checkpoint-1",
        }
        mock_post.side_effect = [intent_response, gate_response]

        modified = plugin.before_tool_call("write", {"path": "notes.txt", "content": "hello"})

        self.assertIn("_paddock_correlation", modified)
        self.assertEqual(modified["_paddock_snapshot_ref"], "snap-checkpoint-1")

    @patch("requests.Session.post")
    def test_after_tool_call_reports_snapshot_ref(self, mock_post) -> None:
        plugin = PaddockAMPPlugin(config=self.test_config)
        mock_post.return_value = Mock(status_code=200)

        plugin.after_tool_call(
            "write",
            {
                "path": "notes.txt",
                "_paddock_correlation": "corr-write-1",
                "_paddock_snapshot_ref": "snap-checkpoint-1",
            },
            {"path": "notes.txt"},
        )

        self.assertEqual(mock_post.call_count, 1)
        self.assertIn("/amp/event", mock_post.call_args.args[0])
        self.assertEqual(
            mock_post.call_args.kwargs["json"]["snapshotRef"],
            "snap-checkpoint-1",
        )


if __name__ == "__main__":
    unittest.main()
