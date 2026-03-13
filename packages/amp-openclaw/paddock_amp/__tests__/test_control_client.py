"""
Unit tests for the control-plane client used by native OpenClaw tools.

Tests cover:
- calling amp/control through the Sidecar
- error handling for HTTP and network failures
"""

import unittest
from unittest.mock import Mock, patch

from paddock_amp.config import AgentConfig
from paddock_amp.tools.control_client import ControlPlaneClient, ControlPlaneError


class TestControlPlaneClient(unittest.TestCase):
    def setUp(self):
        self.config = AgentConfig(
            llm_provider="anthropic",
            agent_model="claude-3-5-haiku-latest",
            llm_base_url=None,
            llm_api_key=None,
            agent_max_tokens=256,
            agent_request_timeout_s=60,
            sidecar_url="http://localhost:8801",
            command_file="/tmp/test-commands.jsonl",
            workspace_root="/tmp/workspace",
            max_file_size=1024 * 1024,
            exec_timeout=30,
        )
        self.client = ControlPlaneClient(self.config)

    @patch("requests.Session.post")
    def test_call_tool_success(self, mock_post):
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"sessions": []}
        mock_post.return_value = mock_response

        result = self.client.call_tool("sessions_list", {})

        self.assertEqual(result, {"sessions": []})
        mock_post.assert_called_once()
        self.assertIn("/amp/control", mock_post.call_args[0][0])
        self.assertEqual(
            mock_post.call_args[1]["json"],
            {"toolName": "sessions_list", "args": {}},
        )

    @patch("requests.Session.post")
    def test_call_tool_http_error(self, mock_post):
        mock_response = Mock()
        mock_response.status_code = 500
        mock_response.raise_for_status.side_effect = Exception("Internal Server Error")
        mock_post.return_value = mock_response

        with self.assertRaises(ControlPlaneError) as ctx:
            self.client.call_tool("sessions_list", {})

        self.assertIn("failed", str(ctx.exception).lower())

    @patch("requests.Session.post")
    def test_call_tool_timeout(self, mock_post):
        import requests

        mock_post.side_effect = requests.Timeout("Request timed out")

        with self.assertRaises(ControlPlaneError) as ctx:
            self.client.call_tool("sessions_list", {})

        self.assertIn("timeout", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
