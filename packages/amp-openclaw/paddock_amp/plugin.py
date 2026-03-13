"""
Paddock AMP Plugin for OpenClaw.

Intercepts tool calls and routes them through the Paddock security engine
via the Sidecar's /amp/gate endpoint for synchronous approval.
Also implements Agent Lifecycle reporting (ready, error, exit, heartbeat).
Polls for user commands from the Dashboard via /tmp/paddock-commands.jsonl.
"""

import os
import json
import time
import threading
from uuid import uuid4
from typing import Any, Callable, Optional, List, Dict

import requests

from .config import AgentConfig


class ToolBlockedError(Exception):
    """Raised when a tool call is blocked by Paddock's security engine."""
    pass


class PaddockAMPPlugin:
    """
    AMP plugin that integrates with OpenClaw's tool lifecycle hooks.

    before_tool_call: synchronous blocking approval via /amp/gate
    after_tool_call: reports tool results for taint tracking
    llm_input/llm_output: reports LLM request/response events
    report_ready/report_error/report_exit: agent lifecycle events
    """

    def __init__(self, sidecar_url: Optional[str] = None, agent_version: str = "0.1.0", config: Optional[AgentConfig] = None):
        # Load config if not provided
        self.config = config or AgentConfig.load()

        self.sidecar_url = sidecar_url or self.config.sidecar_url
        self.agent_version = agent_version
        self._start_time = time.time()
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # Command polling
        self._command_callbacks: List[Callable[[str], None]] = []
        self._command_offset = 0  # lines already read from command file
        self._poll_thread: Optional[threading.Thread] = None
        self._poll_stop = threading.Event()

    # ─── Agent Lifecycle ───

    def report_ready(self, capabilities: Optional[List[str]] = None) -> None:
        """Report that the agent is ready to accept tasks."""
        try:
            self.session.post(
                f"{self.sidecar_url}/amp/agent/ready",
                json={
                    "version": self.agent_version,
                    "capabilities": capabilities or [],
                },
                timeout=5,
            )
        except requests.RequestException:
            pass

    # ─── Command Polling ───

    def on_command(self, callback: Callable[[str], None]) -> None:
        """Register a callback to be called when a user command arrives."""
        self._command_callbacks.append(callback)

    def start_command_polling(self, interval: float = 1.0) -> None:
        """Start a background thread that polls for user commands."""
        if self._poll_thread and self._poll_thread.is_alive():
            return
        # Read past any existing lines on startup so we don't replay old commands
        self._command_offset = self._count_existing_lines()
        self._poll_stop.clear()
        self._poll_thread = threading.Thread(
            target=self._poll_loop, args=(interval,), daemon=True
        )
        self._poll_thread.start()

    def stop_command_polling(self) -> None:
        """Stop the command polling thread."""
        self._poll_stop.set()
        if self._poll_thread:
            self._poll_thread.join(timeout=3)

    def get_pending_commands(self) -> List[str]:
        """Non-blocking: read any new commands from the command file."""
        commands: List[str] = []
        try:
            with open(self.config.command_file, "r") as f:
                lines = f.readlines()
            new_lines = lines[self._command_offset:]
            self._command_offset = len(lines)
            for line in new_lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    commands.append(entry.get("command", ""))
                except json.JSONDecodeError:
                    pass
        except FileNotFoundError:
            pass
        return commands

    def _count_existing_lines(self) -> int:
        try:
            with open(self.config.command_file, "r") as f:
                return len(f.readlines())
        except FileNotFoundError:
            return 0

    def _poll_loop(self, interval: float) -> None:
        while not self._poll_stop.is_set():
            commands = self.get_pending_commands()
            for cmd in commands:
                for cb in self._command_callbacks:
                    try:
                        cb(cmd)
                    except Exception:
                        pass
            self._poll_stop.wait(interval)

    def report_error(
        self,
        category: str,
        code: str,
        message: str,
        recoverable: bool = True,
        context: Optional[Dict] = None,
    ) -> None:
        """Report a categorized error to the platform."""
        try:
            self.session.post(
                f"{self.sidecar_url}/amp/agent/error",
                json={
                    "category": category,
                    "code": code,
                    "message": message,
                    "recoverable": recoverable,
                    "context": context or {},
                },
                timeout=5,
            )
        except requests.RequestException:
            pass

    def report_exit(
        self, exit_code: int = 0, reason: str = "normal"
    ) -> None:
        """Report that the agent is exiting."""
        try:
            self.session.post(
                f"{self.sidecar_url}/amp/agent/exit",
                json={"exitCode": exit_code, "reason": reason},
                timeout=5,
            )
        except requests.RequestException:
            pass

    def get_health_status(self) -> Dict:
        """Return current health status for heartbeat."""
        import psutil  # optional dependency
        proc = psutil.Process()
        return {
            "healthy": True,
            "uptime": int(time.time() - self._start_time),
            "memoryMB": round(proc.memory_info().rss / 1024 / 1024),
            "pendingTasks": 0,
        }

    # ─── Tool Lifecycle ───

    def before_tool_call(
        self, tool_name: str, tool_input: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Synchronous blocking approval request.
        Blocks until the security engine (and optionally HITL) returns a verdict.
        """
        correlation_id = str(uuid4())
        self._report(
            "amp.tool.intent",
            {
                "toolName": tool_name,
                "toolInput": tool_input,
                "correlationId": correlation_id,
            },
        )

        try:
            resp = self.session.post(
                f"{self.sidecar_url}/amp/gate",
                json={
                    "correlationId": correlation_id,
                    "toolName": tool_name,
                    "toolInput": tool_input,
                    "session": {
                        "agentVersion": self.agent_version,
                    },
                    "workspace": {
                        "root": self.config.workspace_root,
                        "commandFile": self.config.command_file,
                    },
                    "riskHints": self._build_risk_hints(tool_name, tool_input),
                },
                timeout=300,  # 5 min max (HITL scenario)
            )
            resp.raise_for_status()
            verdict = resp.json()
        except requests.RequestException as e:
            # If sidecar is unreachable, fail-closed
            raise ToolBlockedError(f"Paddock sidecar unreachable: {e}")

        verdict_name = verdict.get("verdict")
        if verdict_name == "reject" or verdict_name == "ask":
            raise ToolBlockedError(
                verdict.get("reason", "Blocked by Paddock security engine")
            )

        modified_input = tool_input
        if verdict_name == "modify":
            maybe_modified = verdict.get("modifiedInput", tool_input)
            if isinstance(maybe_modified, dict):
                modified_input = maybe_modified

        # Attach correlation / checkpoint metadata for after_tool_call tracking.
        modified_input["_paddock_correlation"] = correlation_id
        snapshot_ref = verdict.get("snapshotRef")
        if isinstance(snapshot_ref, str) and snapshot_ref:
            modified_input["_paddock_snapshot_ref"] = snapshot_ref
        return modified_input

    def after_tool_call(
        self, tool_name: str, tool_input: Dict[str, Any], result: Any
    ) -> Any:
        """Report tool result to sidecar for taint tracking."""
        correlation_id = tool_input.pop("_paddock_correlation", None)
        snapshot_ref = tool_input.pop("_paddock_snapshot_ref", None)
        result_str = self._serialize_payload(result)

        try:
            self.session.post(
                f"{self.sidecar_url}/amp/event",
                json={
                    "toolName": tool_name,
                    "result": result_str,
                    "correlationId": correlation_id,
                    "snapshotRef": snapshot_ref,
                    "path": tool_input.get("path"),
                },
                timeout=5,
            )
        except requests.RequestException:
            pass  # Non-critical, don't block agent

        return result

    def llm_input(self, messages: List[Dict]) -> List[Dict]:
        """Report LLM request event."""
        self._report("amp.llm.request", {"messageCount": len(messages)})
        return messages

    def llm_output(self, response: Dict) -> Dict:
        """Report LLM response event. Detect error responses and report them."""
        # Check if the response indicates an error (e.g. missing API key)
        error = response.get("error")
        status = response.get("status") or response.get("status_code")
        if error or (isinstance(status, int) and status >= 400):
            error_msg = self._extract_llm_error_message(response, error, status)
            category, code = self._classify_llm_error(response, error_msg, status)
            self.report_error(
                category=category,
                code=code,
                message=error_msg,
                recoverable=(category != "auth"),
                context={"model": response.get("model", "unknown"), "status": status},
            )
        else:
            self._report(
                "amp.llm.response",
                {"model": response.get("model", "unknown")},
            )
        return response

    def _report(self, event_type: str, payload: Dict) -> None:
        """Fire-and-forget event report to sidecar."""
        try:
            self.session.post(
                f"{self.sidecar_url}/amp/event",
                json={"toolName": event_type, "result": json.dumps(payload)},
                timeout=2,
            )
        except requests.RequestException:
            pass

    def _extract_llm_error_message(
        self, response: Dict, error: Any, status: Optional[int]
    ) -> str:
        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            if isinstance(error.get("message"), str):
                return error["message"]
            return json.dumps(error, ensure_ascii=False)
        if isinstance(response.get("message"), str):
            return response["message"]
        if isinstance(response.get("msg"), str):
            return response["msg"]
        return f"LLM error status {status}"

    def _classify_llm_error(
        self, response: Dict, error_msg: str, status: Optional[int]
    ) -> tuple[str, str]:
        status_hint = status
        if isinstance(response.get("code"), int):
            status_hint = response["code"]
        elif isinstance(response.get("error"), dict) and isinstance(
            response["error"].get("code"), int
        ):
            status_hint = response["error"]["code"]

        error_lower = error_msg.lower()
        if "api key" in error_lower or "api_key" in error_lower or status_hint == 401:
            return "auth", "ERR_NO_API_KEY"
        if status_hint == 429 or "rate limit" in error_lower:
            return "resource", "ERR_RATE_LIMIT"
        return "runtime", "ERR_LLM_CALL_FAILED"

    def _serialize_payload(self, payload: Any) -> str:
        if payload is None:
            return ""
        if isinstance(payload, str):
            return payload[:2000]
        try:
            return json.dumps(payload, ensure_ascii=False)[:4000]
        except TypeError:
            return str(payload)[:2000]

    def _build_risk_hints(self, tool_name: str, tool_input: Dict[str, Any]) -> List[str]:
        hints: List[str] = []
        if tool_name in {"write", "edit", "apply_patch"}:
            hints.append("file-mutation")
        if tool_name in {"exec", "process"}:
            hints.append("process-execution")
        if tool_name == "browser":
            hints.append("browser-automation")
        path = tool_input.get("path")
        if isinstance(path, str) and path.startswith("/etc/"):
            hints.append("system-path")
        action = tool_input.get("action")
        if tool_name == "browser" and isinstance(action, str):
            normalized = action.strip().lower()
            if normalized in {"open", "navigate", "upload", "dialog", "act"}:
                hints.append("browser-mutation")
        return hints
