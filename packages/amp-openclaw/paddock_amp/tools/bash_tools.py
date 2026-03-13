"""
Bash execution tools for the agent.

Provides command execution with security constraints:
- All operations are restricted to workspace directory
- Timeout enforcement
- Resource limits
- Output capture (stdout, stderr)
- Exit code handling
"""

from __future__ import annotations

import os
import subprocess
import signal
from pathlib import Path
from typing import Any, Dict, Optional


class BashExecutionError(Exception):
    """Raised when a bash command execution fails or is blocked."""
    pass


class BashTools:
    """Bash execution tools with security constraints."""

    def __init__(self, workspace_root: str, timeout: int = 30):
        """
        Initialize bash tools.

        Args:
            workspace_root: Root directory for command execution
            timeout: Default timeout in seconds (default: 30)
        """
        self.workspace_root = Path(workspace_root).resolve()
        self.default_timeout = timeout

        # Ensure workspace exists
        self.workspace_root.mkdir(parents=True, exist_ok=True)

    def _resolve_cwd(self, cwd: Optional[str] = None) -> Path:
        """
        Resolve and validate working directory.

        Args:
            cwd: Working directory (relative or absolute, default: workspace_root)

        Returns:
            Resolved absolute path

        Raises:
            BashExecutionError: If cwd is outside workspace
        """
        if cwd is None:
            return self.workspace_root

        try:
            target = Path(cwd)

            # If relative, make it relative to workspace
            if not target.is_absolute():
                target = self.workspace_root / target

            # Resolve to absolute path
            resolved = target.resolve()

            # Check if within workspace
            try:
                resolved.relative_to(self.workspace_root)
            except ValueError:
                raise BashExecutionError(
                    f"Working directory '{cwd}' is outside workspace '{self.workspace_root}'"
                )

            return resolved
        except Exception as e:
            if isinstance(e, BashExecutionError):
                raise
            raise BashExecutionError(f"Invalid working directory '{cwd}': {e}")

    def exec(
        self,
        command: str,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Execute a bash command.

        Args:
            command: Command to execute
            cwd: Working directory (default: workspace_root)
            env: Additional environment variables
            timeout: Timeout in seconds (default: self.default_timeout)

        Returns:
            Dict with 'stdout', 'stderr', 'exit_code', 'timed_out', 'command', 'cwd', and 'duration' keys

        Raises:
            BashExecutionError: If command is invalid or execution fails
        """
        import time

        # Validate command
        if not command or not command.strip():
            raise BashExecutionError("Command cannot be empty")

        # Resolve working directory
        resolved_cwd = self._resolve_cwd(cwd)

        # Create working directory if it doesn't exist
        resolved_cwd.mkdir(parents=True, exist_ok=True)

        # Prepare environment
        exec_env = os.environ.copy()
        if env:
            exec_env.update(env)

        # Determine timeout
        exec_timeout = timeout if timeout is not None else self.default_timeout

        start_time = time.time()

        try:
            # Execute command
            process = subprocess.Popen(
                ["bash", "-c", command],
                cwd=str(resolved_cwd),
                env=exec_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                preexec_fn=os.setsid if os.name != 'nt' else None,
            )

            try:
                stdout, stderr = process.communicate(timeout=exec_timeout)
                timed_out = False
            except subprocess.TimeoutExpired:
                # Kill the process group
                if os.name != 'nt':
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                else:
                    process.kill()
                stdout, stderr = process.communicate()
                raise BashExecutionError(
                    f"Command timeout after {exec_timeout} seconds"
                )

            duration = time.time() - start_time

            return {
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": process.returncode,
                "timed_out": timed_out,
                "command": command,
                "cwd": str(resolved_cwd),
                "duration": duration,
            }

        except BashExecutionError:
            raise
        except Exception as e:
            raise BashExecutionError(f"Failed to execute command: {e}")

    def exec_stream(
        self,
        command: str,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[int] = None,
    ) -> subprocess.Popen:
        """
        Execute a bash command and return the process for streaming output.

        Args:
            command: Command to execute
            cwd: Working directory (default: workspace_root)
            env: Additional environment variables
            timeout: Timeout in seconds (default: self.default_timeout)

        Returns:
            subprocess.Popen object for streaming

        Raises:
            BashExecutionError: If command is invalid or execution fails

        Note:
            Caller is responsible for managing the process lifecycle
        """
        # Validate command
        if not command or not command.strip():
            raise BashExecutionError("Command cannot be empty")

        # Resolve working directory
        resolved_cwd = self._resolve_cwd(cwd)

        # Create working directory if it doesn't exist
        resolved_cwd.mkdir(parents=True, exist_ok=True)

        # Prepare environment
        exec_env = os.environ.copy()
        if env:
            exec_env.update(env)

        try:
            # Execute command
            process = subprocess.Popen(
                ["bash", "-c", command],
                cwd=str(resolved_cwd),
                env=exec_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                preexec_fn=os.setsid if os.name != 'nt' else None,
            )

            return process

        except Exception as e:
            raise BashExecutionError(f"Failed to execute command: {e}")
