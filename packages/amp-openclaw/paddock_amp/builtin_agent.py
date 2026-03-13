"""
Built-in OpenClaw-compatible agent runner for Paddock.

This runtime keeps the adapter thin:
- commands come from Sidecar polling
- model/tool planning happens through provider tool-calling APIs
- sandbox-local tools stay in the VM
- control-plane orchestration goes through amp/control
- external tools stay behind MCP
"""

from __future__ import annotations

import json
import signal
import sys
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

from .llm_client import LLMClientResult, create_llm_client
from .plugin import PaddockAMPPlugin, ToolBlockedError
from .tools.tool_registry import ToolRegistry

DEFAULT_SYSTEM_PROMPT = (
    "You are OpenClaw running inside a Paddock sandbox. "
    "Use sandbox-local tools for workspace files and shell work. "
    "Use session/subagent/rollback tools for orchestration. "
    "Use MCP tools only for true host or external side effects."
)


class BuiltinOpenClawAgent:
    def __init__(
        self,
        plugin: Optional[PaddockAMPPlugin] = None,
        client: Any = None,
        tool_registry: Optional[ToolRegistry] = None,
    ) -> None:
        self.plugin = plugin or PaddockAMPPlugin(agent_version="paddock-openclaw-native")
        self.running = True
        self.client = client or create_llm_client()
        self.model = getattr(self.client.config, "model", "unknown")
        self.provider = getattr(self.client.config, "provider", "unknown")
        self.base_url = getattr(self.client.config, "base_url", "")
        self.tool_registry = tool_registry or self._build_tool_registry()

    def _build_tool_registry(self) -> ToolRegistry:
        registry = ToolRegistry(self.plugin, self.plugin.config)
        registry.register_file_tools()
        registry.register_bash_tools()
        registry.register_browser_tools()
        registry.register_control_tools()
        try:
            registry.register_mcp_tools()
        except Exception as exc:  # pragma: no cover - defensive: local tools still work without MCP
            print(f"[builtin-agent] mcp tool registration skipped: {exc}", flush=True)
        return registry

    def start(self) -> None:
        print(
            f"[builtin-agent] starting provider={self.provider} model={self.model} sidecar={self.plugin.sidecar_url}",
            flush=True,
        )
        self._wait_for_ready_registration()
        self.plugin.on_command(self.handle_command)
        self.plugin.start_command_polling(interval=1.0)
        print("[builtin-agent] command polling started", flush=True)

        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT, self._handle_signal)

        while self.running:
            time.sleep(1)

    def _handle_signal(self, signum: int, _frame: Any) -> None:
        self.running = False
        self.plugin.stop_command_polling()
        self.plugin.report_exit(exit_code=0, reason="killed" if signum == signal.SIGTERM else "normal")
        sys.exit(0)

    def handle_command(self, command: str) -> None:
        print(f"[builtin-agent] received command: {command}", flush=True)

        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": DEFAULT_SYSTEM_PROMPT},
            {"role": "user", "content": command},
        ]
        tools = self.tool_registry.get_tool_schemas()

        try:
            for _ in range(12):
                outgoing_messages = messages
                if not self._routes_through_sidecar_proxy():
                    outgoing_messages = self.plugin.llm_input(messages)

                result = self.client.complete(outgoing_messages, tools=tools)

                if not self._routes_through_sidecar_proxy():
                    self.plugin.llm_output(result.payload)

                if result.status >= 400:
                    print(
                        f"[builtin-agent] llm call failed provider={self.provider} status={result.status}",
                        flush=True,
                    )
                    return

                tool_calls = list(getattr(result, "tool_calls", []) or [])
                if tool_calls:
                    messages.append(
                        {
                            "role": "assistant",
                            "content": result.text,
                            "tool_calls": [
                                {"id": tool_call.id, "name": tool_call.name, "input": tool_call.input}
                                for tool_call in tool_calls
                            ],
                        }
                    )
                    if not self._run_tool_calls(messages, tool_calls):
                        return
                    continue

                self._report_thought(result)
                return

            self.plugin.report_error(
                category="runtime",
                code="ERR_TOOL_LOOP_EXCEEDED",
                message="Tool loop exceeded 12 iterations without a final response.",
                recoverable=True,
                context={"command": command},
            )
        except requests.RequestException as exc:
            print(f"[builtin-agent] request failed: {exc}", flush=True)
            self.plugin.report_error(
                category="network",
                code="ERR_AGENT_REQUEST_FAILED",
                message=str(exc),
                recoverable=True,
                context={"command": command},
            )
        except Exception as exc:  # pragma: no cover - defensive catch for runtime safety
            print(f"[builtin-agent] runtime failure: {exc}", flush=True)
            self.plugin.report_error(
                category="runtime",
                code="ERR_AGENT_COMMAND_FAILED",
                message=str(exc),
                recoverable=True,
                context={"command": command},
            )

    def _run_tool_calls(self, messages: List[Dict[str, Any]], tool_calls: List[Any]) -> bool:
        for tool_call in tool_calls:
            try:
                tool_result = self.tool_registry.execute_tool(tool_call.name, tool_call.input)
            except ToolBlockedError as exc:
                self.plugin.report_error(
                    category="runtime",
                    code="ERR_TOOL_BLOCKED",
                    message=str(exc),
                    recoverable=True,
                    context={"tool": tool_call.name, "tool_call_id": tool_call.id},
                )
                return False
            except Exception as exc:
                self.plugin.report_error(
                    category="runtime",
                    code="ERR_TOOL_FAILED",
                    message=str(exc),
                    recoverable=True,
                    context={"tool": tool_call.name, "tool_call_id": tool_call.id},
                )
                return False

            messages.append(
                {
                    "role": "tool",
                    "name": tool_call.name,
                    "tool_call_id": tool_call.id,
                    "content": self._serialize_tool_result(tool_result),
                }
            )
        return True

    def _serialize_tool_result(self, result: Any) -> str:
        if isinstance(result, str):
            return result
        try:
            return json.dumps(result, ensure_ascii=False)
        except TypeError:
            return str(result)

    def _report_thought(self, result: LLMClientResult) -> None:
        if not result.text:
            return
        print(f"[builtin-agent] model response: {result.text[:200]}", flush=True)
        self.plugin._report("amp.thought", {"text": result.text})  # noqa: SLF001

    def _routes_through_sidecar_proxy(self) -> bool:
        parsed = urlparse(self.base_url)
        if parsed.hostname not in {"127.0.0.1", "localhost"}:
            return False
        if parsed.port != 8800:
            return False
        return parsed.path.rstrip("/") in {
            "/anthropic",
            "/openai",
            "/openrouter",
            "/google",
        }

    def _wait_for_ready_registration(self) -> None:
        payload = {
            "version": "paddock-openclaw-native",
            "capabilities": ["chat", "tools", "browser", "sessions", "rollback"],
            "provider": self.provider,
            "model": self.model,
        }

        for attempt in range(1, 21):
            try:
                response = self.plugin.session.post(
                    f"{self.plugin.sidecar_url}/amp/agent/ready",
                    json=payload,
                    timeout=5,
                )
                if response.ok:
                    print(
                        f"[builtin-agent] registered amp.agent.ready on attempt {attempt}",
                        flush=True,
                    )
                    return
                print(
                    f"[builtin-agent] ready registration failed with HTTP {response.status_code}: {response.text[:200]}",
                    flush=True,
                )
            except requests.RequestException as exc:
                print(
                    f"[builtin-agent] ready registration attempt {attempt} failed: {exc}",
                    flush=True,
                )

            time.sleep(1)

        raise RuntimeError("Failed to register agent readiness with the Sidecar")


def main() -> None:
    agent = BuiltinOpenClawAgent()
    agent.start()


if __name__ == "__main__":
    main()
