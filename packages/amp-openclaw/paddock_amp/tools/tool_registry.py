"""
Tool registry for integrating tools with AMP Gate.

Provides:
- Tool registration and discovery
- Tool execution with AMP Gate interception
- Automatic input validation and modification
- Result reporting
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from ..plugin import PaddockAMPPlugin, ToolBlockedError
from ..config import AgentConfig
from .file_tools import FileTools, FileOperationError
from .bash_tools import BashTools, BashExecutionError
from .browser_tools import BrowserTools, BrowserOperationError
from .mcp_client import MCPClient
from .control_client import ControlPlaneClient


@dataclass
class ToolDefinition:
    """Definition of a tool available to the agent."""

    name: str
    description: str
    parameters: Dict[str, Any]
    handler: Callable[[Dict[str, Any]], Any]
    alias_of: Optional[str] = None
    llm_exposed: bool = True


class ToolRegistry:
    """Registry for managing and executing tools with AMP Gate integration."""

    # Paddock's MCP boundary is reserved for host/external integrations.
    # Sandbox-local tools such as read/write/edit/exec should stay inside the VM.
    EXTERNAL_MCP_PREFIXES = (
        "api.",
        "applescript.",
        "channel.",
        "clipboard.",
        "tts.",
    )

    def __init__(self, plugin: PaddockAMPPlugin, config: AgentConfig):
        """
        Initialize tool registry.

        Args:
            plugin: PaddockAMPPlugin instance for AMP Gate integration
            config: AgentConfig instance for tool configuration
        """
        self.plugin = plugin
        self.config = config
        self._tools: Dict[str, ToolDefinition] = {}

        # Initialize tool implementations
        self.file_tools = FileTools(
            workspace_root=config.workspace_root,
            max_file_size=config.max_file_size,
        )
        self.bash_tools = BashTools(
            workspace_root=config.workspace_root,
            timeout=config.exec_timeout,
        )
        self.browser_tools = BrowserTools(
            workspace_root=config.workspace_root,
            headless=config.browser_headless,
            default_timeout_ms=config.browser_default_timeout_ms,
            output_dir=config.browser_output_dir,
        )
        self.control_client = ControlPlaneClient(config)
        self.mcp_client = MCPClient(config)

    def _register_tool(
        self,
        name: str,
        description: str,
        parameters: Dict[str, Any],
        handler: Callable[[Dict[str, Any]], Any],
        *,
        aliases: Optional[List[str]] = None,
    ) -> None:
        self._tools[name] = ToolDefinition(
            name=name,
            description=description,
            parameters=parameters,
            handler=handler,
            llm_exposed=True,
        )
        for alias in aliases or []:
            self._tools[alias] = ToolDefinition(
                name=alias,
                description=description,
                parameters=parameters,
                handler=handler,
                alias_of=name,
                llm_exposed=False,
            )

    def register_file_tools(self) -> None:
        """Register file operation tools."""
        self._register_tool(
            name="read",
            description="Read contents of a file",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file (relative to workspace)",
                    },
                    "encoding": {
                        "type": "string",
                        "description": "Text encoding (default: utf-8)",
                        "default": "utf-8",
                    },
                },
                "required": ["path"],
            },
            handler=lambda args: self.file_tools.read_file(
                args["path"], args.get("encoding", "utf-8")
            ),
            aliases=["read_file"],
        )

        self._register_tool(
            name="write",
            description="Write content to a file (creates or overwrites)",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file (relative to workspace)",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write",
                    },
                    "encoding": {
                        "type": "string",
                        "description": "Text encoding (default: utf-8)",
                        "default": "utf-8",
                    },
                },
                "required": ["path", "content"],
            },
            handler=lambda args: self.file_tools.write_file(
                args["path"], args["content"], args.get("encoding", "utf-8")
            ),
            aliases=["write_file"],
        )

        self._register_tool(
            name="edit",
            description="Edit a file by replacing text",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file (relative to workspace)",
                    },
                    "old_text": {
                        "type": "string",
                        "description": "Text to find and replace",
                    },
                    "new_text": {
                        "type": "string",
                        "description": "Replacement text",
                    },
                    "encoding": {
                        "type": "string",
                        "description": "Text encoding (default: utf-8)",
                        "default": "utf-8",
                    },
                },
                "required": ["path", "old_text", "new_text"],
            },
            handler=lambda args: self.file_tools.edit_file(
                args["path"],
                args["old_text"],
                args["new_text"],
                args.get("encoding", "utf-8"),
            ),
            aliases=["edit_file"],
        )

        self._register_tool(
            name="list",
            description="List contents of a directory",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the directory (relative to workspace, default: .)",
                        "default": ".",
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Optional glob pattern (e.g., *.txt)",
                    },
                },
            },
            handler=lambda args: self.file_tools.list_directory(
                args.get("path", "."), args.get("pattern")
            ),
            aliases=["list_directory"],
        )

        self._register_tool(
            name="apply_patch",
            description="Apply a patch using the *** Begin Patch / *** End Patch format.",
            parameters={
                "type": "object",
                "properties": {
                    "input": {
                        "type": "string",
                        "description": "Patch content in apply_patch format",
                    },
                },
                "required": ["input"],
            },
            handler=lambda args: self.file_tools.apply_patch(args["input"]),
        )

    def register_bash_tools(self) -> None:
        """Register bash execution tools."""
        self._register_tool(
            name="exec",
            description="Execute a bash command",
            parameters={
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Bash command to execute",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory (relative to workspace, default: workspace root)",
                    },
                    "env": {
                        "type": "object",
                        "description": "Additional environment variables",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds",
                    },
                },
                "required": ["command"],
            },
            handler=lambda args: self.bash_tools.exec(
                args["command"],
                args.get("cwd"),
                args.get("env"),
                args.get("timeout"),
            ),
            aliases=["bash_exec"],
        )

    def register_browser_tools(self) -> None:
        """Register sandbox-local browser automation tool."""
        self._register_tool(
            name="browser",
            description=(
                "Control the sandbox-local browser with OpenClaw-style actions "
                "(status/start/stop/profiles/tabs/open/focus/close/snapshot/"
                "screenshot/navigate/console/pdf/upload/dialog/act)."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "Browser action to perform"},
                    "target": {"type": "string", "description": "Must be sandbox when specified"},
                    "targetId": {"type": "string", "description": "Tab identifier"},
                    "targetUrl": {"type": "string", "description": "Target URL"},
                    "url": {"type": "string", "description": "Target URL"},
                    "type": {"type": "string", "description": "Image type for screenshots"},
                    "fullPage": {"type": "boolean"},
                    "path": {"type": "string"},
                    "paths": {"type": "array", "items": {"type": "string"}},
                    "ref": {"type": "string"},
                    "selector": {"type": "string"},
                    "accept": {"type": "boolean"},
                    "promptText": {"type": "string"},
                    "request": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string"},
                            "targetId": {"type": "string"},
                            "ref": {"type": "string"},
                            "selector": {"type": "string"},
                            "doubleClick": {"type": "boolean"},
                            "button": {"type": "string"},
                            "modifiers": {"type": "array", "items": {"type": "string"}},
                            "text": {"type": "string"},
                            "slowly": {"type": "boolean"},
                            "key": {"type": "string"},
                            "delayMs": {"type": "integer"},
                            "values": {"type": "array", "items": {"type": "string"}},
                            "fields": {"type": "array", "items": {"type": "object"}},
                            "width": {"type": "integer"},
                            "height": {"type": "integer"},
                            "timeMs": {"type": "integer"},
                            "url": {"type": "string"},
                            "loadState": {"type": "string"},
                            "timeoutMs": {"type": "integer"},
                            "fn": {"type": "string"},
                        },
                    },
                },
                "required": ["action"],
            },
            handler=lambda args: self.browser_tools.execute(args),
        )

    def register_control_tools(self) -> None:
        """Register control-plane-routed orchestration tools."""
        control_tools = [
            (
                "sessions_list",
                "List visible Paddock sessions for orchestration.",
                {
                    "type": "object",
                    "properties": {},
                },
            ),
            (
                "sessions_history",
                "Fetch recent event history for a Paddock session.",
                {
                    "type": "object",
                    "properties": {
                        "sessionId": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1},
                    },
                },
            ),
            (
                "sessions_send",
                "Send a command into another running session.",
                {
                    "type": "object",
                    "properties": {
                        "sessionId": {"type": "string"},
                        "message": {"type": "string"},
                    },
                    "required": ["sessionId", "message"],
                },
            ),
            (
                "sessions_spawn",
                "Create a new sandbox session or subagent run.",
                {
                    "type": "object",
                    "properties": {
                        "agentType": {"type": "string"},
                        "sandboxType": {"type": "string"},
                        "autoStart": {"type": "boolean"},
                        "autoDeploy": {"type": "boolean"},
                    },
                },
            ),
            (
                "sessions_yield",
                "Yield the current turn back to the orchestrator.",
                {
                    "type": "object",
                    "properties": {
                        "message": {"type": "string"},
                    },
                },
            ),
            (
                "session_status",
                "Fetch status for the current or another session.",
                {
                    "type": "object",
                    "properties": {
                        "sessionId": {"type": "string"},
                    },
                },
            ),
            (
                "subagents",
                "List, steer, or terminate child sessions created from this one.",
                {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string"},
                        "sessionId": {"type": "string"},
                        "message": {"type": "string"},
                    },
                },
            ),
            (
                "cron",
                "Manage control-plane cron jobs for future session work.",
                {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string"},
                    },
                },
            ),
            (
                "rollback",
                "Restore a previous session state or roll back event history.",
                {
                    "type": "object",
                    "properties": {
                        "snapshotId": {"type": "string"},
                        "toSeq": {"type": "integer", "minimum": 0},
                    },
                },
            ),
        ]

        for name, description, parameters in control_tools:
            self._register_tool(
                name=name,
                description=description,
                parameters=parameters,
                handler=lambda args, tool_name=name: self.control_client.call_tool(tool_name, args),
            )

    def register_mcp_tools(self, allowlist: Optional[List[str]] = None) -> None:
        """
        Register host/external MCP tools exposed by the sidecar gateway.

        Only external-boundary tools are registered here by default. Sandbox-local
        operations should remain implemented by local VM tools instead of being
        re-routed through MCP.

        Args:
            allowlist: Optional explicit list of MCP tool names to register.
        """
        allowed_names = set(allowlist or [])
        for tool in self.mcp_client.list_tools():
            name = str(tool.get("name") or "").strip()
            if not name:
                continue
            if allowed_names and name not in allowed_names:
                continue
            if not self._should_register_mcp_tool(name):
                continue

            parameters = tool.get("parameters") or tool.get("input_schema") or {}
            if not isinstance(parameters, dict):
                parameters = {}

            description = str(tool.get("description") or f"MCP tool: {name}")
            self._tools[name] = ToolDefinition(
                name=name,
                description=description,
                parameters=parameters,
                handler=lambda args, tool_name=name: self.mcp_client.call_tool(tool_name, args),
            )

    def _should_register_mcp_tool(self, tool_name: str) -> bool:
        """
        Keep MCP scoped to host/external boundary tools.

        This prevents sandbox-local tools from silently drifting onto the host.
        """
        if tool_name in self._tools:
            return False
        return tool_name.startswith(self.EXTERNAL_MCP_PREFIXES)

    def get_tool(self, name: str) -> Optional[ToolDefinition]:
        """
        Get tool definition by name.

        Args:
            name: Tool name

        Returns:
            ToolDefinition or None if not found
        """
        return self._tools.get(name)

    def get_all_tools(self) -> List[ToolDefinition]:
        """
        Get all registered tools.

        Returns:
            List of ToolDefinition objects
        """
        return list(self._tools.values())

    def execute_tool(self, tool_name: str, tool_input: Dict[str, Any]) -> Any:
        """
        Execute a tool with AMP Gate interception.

        Args:
            tool_name: Name of the tool to execute
            tool_input: Tool input parameters

        Returns:
            Tool execution result

        Raises:
            ToolBlockedError: If tool is blocked by AMP Gate
            ValueError: If tool not found or parameters invalid
            FileOperationError: If file operation fails
            BashExecutionError: If bash execution fails
        """
        # Get tool definition
        tool = self.get_tool(tool_name)
        if tool is None:
            raise ValueError(f"Tool not found: {tool_name}")

        # Validate required parameters
        required_params = tool.parameters.get("required", [])
        for param in required_params:
            if param not in tool_input:
                raise ValueError(f"Required parameter '{param}' missing for tool '{tool_name}'")

        # AMP Gate interception (before_tool_call)
        try:
            modified_input = self.plugin.before_tool_call(tool_name, tool_input.copy())
        except ToolBlockedError:
            raise

        # Execute tool
        try:
            result = tool.handler(modified_input)
        except (FileOperationError, BashExecutionError, BrowserOperationError) as e:
            # Report tool error
            self.plugin.after_tool_call(tool_name, modified_input, {"error": str(e)})
            raise

        # Report tool result (after_tool_call)
        self.plugin.after_tool_call(tool_name, modified_input, result)

        return result

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """
        Get tool schemas in OpenAI/Anthropic format.

        Returns:
            List of tool schema dictionaries
        """
        schemas = []
        for tool in self.get_all_tools():
            if not tool.llm_exposed:
                continue
            schemas.append({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            })
        return schemas
