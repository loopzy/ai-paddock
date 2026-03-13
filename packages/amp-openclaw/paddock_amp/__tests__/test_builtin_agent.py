import unittest
from unittest.mock import MagicMock, patch

import requests

from paddock_amp.builtin_agent import BuiltinOpenClawAgent
from paddock_amp.llm_client import (
    LLMClientConfig,
    LLMClientResult,
    ToolCall,
    create_llm_client,
)
from paddock_amp.plugin import ToolBlockedError


class BuiltinOpenClawAgentTests(unittest.TestCase):
    def test_wait_for_ready_registration_retries_until_sidecar_accepts(self) -> None:
        agent = BuiltinOpenClawAgent()
        success_response = MagicMock(ok=True, status_code=200, text="ok")
        agent.plugin.session.post = MagicMock(
            side_effect=[
                requests.RequestException("connection refused"),
                success_response,
            ]
        )

        with patch("builtins.print"), patch("paddock_amp.builtin_agent.time.sleep") as sleep:
            agent._wait_for_ready_registration()

        self.assertEqual(agent.plugin.session.post.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_handle_command_reports_model_output_as_amp_thought(self) -> None:
        agent = BuiltinOpenClawAgent()
        agent.plugin = MagicMock()
        agent.client = MagicMock()
        agent.base_url = "http://127.0.0.1:8800/anthropic"
        agent.client.complete.return_value = MagicMock(
            status=200,
            payload={"content": [{"type": "text", "text": "hello from model"}]},
            text="hello from model",
        )

        with patch("builtins.print"):
            agent.handle_command("hello")

        agent.client.complete.assert_called_once()
        agent.plugin.llm_input.assert_not_called()
        agent.plugin.llm_output.assert_not_called()
        agent.plugin._report.assert_called_once_with("amp.thought", {"text": "hello from model"})
        agent.plugin.report_error.assert_not_called()

    def test_handle_command_reports_network_failures(self) -> None:
        agent = BuiltinOpenClawAgent()
        agent.plugin = MagicMock()
        agent.client = MagicMock()
        agent.client.complete.side_effect = requests.RequestException("boom")

        with patch("builtins.print"):
            agent.handle_command("hello")

        agent.plugin.report_error.assert_called_once_with(
            category="network",
            code="ERR_AGENT_REQUEST_FAILED",
            message="boom",
            recoverable=True,
            context={"command": "hello"},
        )
        agent.plugin._report.assert_not_called()

    def test_handle_command_uses_plugin_llm_hooks_for_direct_provider_urls(self) -> None:
        agent = BuiltinOpenClawAgent()
        agent.plugin = MagicMock()
        agent.client = MagicMock()
        agent.base_url = "https://api.anthropic.com"
        agent.client.complete.return_value = MagicMock(
            status=200,
            payload={"content": [{"type": "text", "text": "hello from model"}]},
            text="hello from model",
        )

        with patch("builtins.print"):
            agent.handle_command("hello")

        agent.plugin.llm_input.assert_called_once()
        agent.plugin.llm_output.assert_called_once()

    def test_handle_command_executes_tool_calls_until_final_response(self) -> None:
        plugin = MagicMock()
        registry = MagicMock()
        registry.get_tool_schemas.return_value = [
            {"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}
        ]
        client = MagicMock()
        client.config = MagicMock(
            provider="anthropic",
            model="claude-3-5-haiku-latest",
            base_url="http://127.0.0.1:8800/anthropic",
        )
        client.complete.side_effect = [
            LLMClientResult(
                status=200,
                payload={"content": [{"type": "tool_use", "id": "call-1", "name": "read", "input": {"path": "README.md"}}]},
                text="",
                tool_calls=[ToolCall(id="call-1", name="read", input={"path": "README.md"})],
                stop_reason="tool_use",
            ),
            LLMClientResult(
                status=200,
                payload={"content": [{"type": "text", "text": "All done"}]},
                text="All done",
                tool_calls=[],
                stop_reason="end_turn",
            ),
        ]
        registry.execute_tool.return_value = {"content": "repo summary"}

        agent = BuiltinOpenClawAgent(plugin=plugin, client=client, tool_registry=registry)

        with patch("builtins.print"):
            agent.handle_command("Summarize README.md")

        registry.execute_tool.assert_called_once_with("read", {"path": "README.md"})
        self.assertEqual(client.complete.call_count, 2)
        second_messages = client.complete.call_args_list[1].args[0]
        self.assertEqual(second_messages[-1]["role"], "tool")
        self.assertEqual(second_messages[-1]["tool_call_id"], "call-1")
        plugin._report.assert_called_with("amp.thought", {"text": "All done"})

    def test_handle_command_reports_blocked_tool_calls(self) -> None:
        plugin = MagicMock()
        registry = MagicMock()
        registry.get_tool_schemas.return_value = [
            {"name": "exec", "description": "Run a command", "input_schema": {"type": "object"}}
        ]
        registry.execute_tool.side_effect = ToolBlockedError("Blocked by policy")
        client = MagicMock()
        client.config = MagicMock(
            provider="anthropic",
            model="claude-3-5-haiku-latest",
            base_url="http://127.0.0.1:8800/anthropic",
        )
        client.complete.return_value = LLMClientResult(
            status=200,
            payload={"content": [{"type": "tool_use", "id": "call-1", "name": "exec", "input": {"command": "rm -rf /"}}]},
            text="",
            tool_calls=[ToolCall(id="call-1", name="exec", input={"command": "rm -rf /"})],
            stop_reason="tool_use",
        )

        agent = BuiltinOpenClawAgent(plugin=plugin, client=client, tool_registry=registry)

        with patch("builtins.print"):
            agent.handle_command("Delete everything")

        plugin.report_error.assert_called_once_with(
            category="runtime",
            code="ERR_TOOL_BLOCKED",
            message="Blocked by policy",
            recoverable=True,
            context={"tool": "exec", "tool_call_id": "call-1"},
        )

    def test_create_llm_client_uses_openrouter_chat_endpoint(self) -> None:
        session = MagicMock()
        response = MagicMock(status_code=200)
        response.json.return_value = {
            "choices": [{"message": {"content": "pong"}}]
        }
        session.post.return_value = response

        client = create_llm_client(
            LLMClientConfig(
                provider="openrouter",
                model="openai/gpt-4o-mini",
                base_url="http://127.0.0.1:8800/openrouter",
                api_key="paddock-proxy",
                max_tokens=32,
                timeout_seconds=30,
            ),
            session=session,
        )

        result = client.complete([{"role": "user", "content": "ping"}])

        session.post.assert_called_once()
        self.assertEqual(
            session.post.call_args.args[0],
            "http://127.0.0.1:8800/openrouter/api/v1/chat/completions",
        )
        self.assertEqual(result.text, "pong")

    def test_openrouter_client_supports_function_tools(self) -> None:
        session = MagicMock()
        response = MagicMock(status_code=200)
        response.json.return_value = {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "type": "function",
                                "function": {
                                    "name": "read",
                                    "arguments": '{"path":"README.md"}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
        session.post.return_value = response

        client = create_llm_client(
            LLMClientConfig(
                provider="openrouter",
                model="openai/gpt-4o-mini",
                base_url="http://127.0.0.1:8800/openrouter",
                api_key="paddock-proxy",
                max_tokens=32,
                timeout_seconds=30,
            ),
            session=session,
        )

        result = client.complete(
            [{"role": "user", "content": "ping"}],
            tools=[{"name": "read", "description": "Read", "input_schema": {"type": "object"}}],
        )

        self.assertEqual(result.tool_calls[0].name, "read")
        self.assertEqual(result.tool_calls[0].input, {"path": "README.md"})
        payload = session.post.call_args.kwargs["json"]
        self.assertIn("tools", payload)
        self.assertEqual(payload["tools"][0]["function"]["name"], "read")

    def test_anthropic_client_supports_tool_use_blocks(self) -> None:
        session = MagicMock()
        response = MagicMock(status_code=200)
        response.json.return_value = {
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu-1",
                    "name": "read",
                    "input": {"path": "README.md"},
                }
            ],
            "stop_reason": "tool_use",
        }
        session.post.return_value = response

        client = create_llm_client(
            LLMClientConfig(
                provider="anthropic",
                model="claude-3-5-haiku-latest",
                base_url="http://127.0.0.1:8800/anthropic",
                api_key="paddock-proxy",
                max_tokens=32,
                timeout_seconds=30,
            ),
            session=session,
        )

        result = client.complete(
            [{"role": "system", "content": "You are helpful."}, {"role": "user", "content": "ping"}],
            tools=[{"name": "read", "description": "Read", "input_schema": {"type": "object"}}],
        )

        payload = session.post.call_args.kwargs["json"]
        self.assertEqual(payload["system"], "You are helpful.")
        self.assertIn("tools", payload)
        self.assertEqual(payload["tools"][0]["name"], "read")
        self.assertEqual(result.tool_calls[0].name, "read")
        self.assertEqual(result.stop_reason, "tool_use")


if __name__ == "__main__":
    unittest.main()
