"""
Unit tests for bash execution tools.

Tests cover:
- Command execution (stdout, stderr, exit codes)
- Timeout handling
- Security constraints (command validation, resource limits)
- Process management
- Error handling
"""

import os
import tempfile
import time
import unittest
from pathlib import Path

from paddock_amp.tools.bash_tools import BashTools, BashExecutionError


class TestBashTools(unittest.TestCase):
    """Test suite for BashTools."""

    def setUp(self):
        """Create temporary workspace for each test."""
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir) / "workspace"
        self.workspace.mkdir()
        self.tools = BashTools(
            workspace_root=str(self.workspace),
            timeout=5,  # 5 seconds for testing
        )

    def tearDown(self):
        """Clean up temporary workspace."""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # ── Basic Command Execution ──

    def test_exec_simple_command_success(self):
        """Test executing a simple command successfully."""
        result = self.tools.exec("echo 'Hello, World!'")

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("Hello, World!", result["stdout"])
        self.assertEqual(result["stderr"], "")

    def test_exec_command_with_exit_code(self):
        """Test command with non-zero exit code."""
        result = self.tools.exec("exit 42")

        self.assertEqual(result["exit_code"], 42)

    def test_exec_captures_stdout(self):
        """Test that stdout is captured correctly."""
        result = self.tools.exec("echo 'line1'; echo 'line2'")

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("line1", result["stdout"])
        self.assertIn("line2", result["stdout"])

    def test_exec_captures_stderr(self):
        """Test that stderr is captured correctly."""
        result = self.tools.exec("echo 'error message' >&2")

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("error message", result["stderr"])

    def test_exec_with_working_directory(self):
        """Test command execution in specific working directory."""
        subdir = self.workspace / "subdir"
        subdir.mkdir()

        result = self.tools.exec("pwd", cwd=str(subdir))

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("subdir", result["stdout"])

    def test_exec_multiline_command(self):
        """Test executing multiline commands."""
        cmd = """
        echo "first"
        echo "second"
        echo "third"
        """
        result = self.tools.exec(cmd)

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("first", result["stdout"])
        self.assertIn("second", result["stdout"])
        self.assertIn("third", result["stdout"])

    # ── Timeout Handling ──

    def test_exec_timeout_kills_process(self):
        """Test that long-running commands are killed on timeout."""
        with self.assertRaises(BashExecutionError) as ctx:
            self.tools.exec("sleep 10")  # Will timeout after 5 seconds

        self.assertIn("timeout", str(ctx.exception).lower())

    def test_exec_custom_timeout(self):
        """Test command with custom timeout."""
        # This should succeed with 2 second timeout
        result = self.tools.exec("sleep 0.5", timeout=2)
        self.assertEqual(result["exit_code"], 0)

        # This should fail with 1 second timeout
        with self.assertRaises(BashExecutionError) as ctx:
            self.tools.exec("sleep 2", timeout=1)
        self.assertIn("timeout", str(ctx.exception).lower())

    # ── Working Directory Constraints ──

    def test_exec_default_cwd_is_workspace(self):
        """Test that default working directory is workspace."""
        result = self.tools.exec("pwd")

        self.assertEqual(result["exit_code"], 0)
        self.assertIn(str(self.workspace), result["stdout"])

    def test_exec_cwd_outside_workspace_blocked(self):
        """Test that working directory outside workspace is blocked."""
        with self.assertRaises(BashExecutionError) as ctx:
            self.tools.exec("pwd", cwd="/tmp")

        self.assertIn("outside workspace", str(ctx.exception).lower())

    def test_exec_cwd_path_traversal_blocked(self):
        """Test that path traversal in cwd is blocked."""
        with self.assertRaises(BashExecutionError) as ctx:
            self.tools.exec("pwd", cwd="../../../etc")

        self.assertIn("outside workspace", str(ctx.exception).lower())

    # ── Environment Variables ──

    def test_exec_with_custom_env(self):
        """Test command with custom environment variables."""
        result = self.tools.exec("echo $MY_VAR", env={"MY_VAR": "test_value"})

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("test_value", result["stdout"])

    def test_exec_inherits_safe_env_vars(self):
        """Test that safe environment variables are inherited."""
        result = self.tools.exec("echo $PATH")

        self.assertEqual(result["exit_code"], 0)
        # PATH should be present
        self.assertTrue(len(result["stdout"].strip()) > 0)

    # ── Command Validation ──

    def test_exec_empty_command_raises_error(self):
        """Test that empty command raises error."""
        with self.assertRaises(BashExecutionError) as ctx:
            self.tools.exec("")

        self.assertIn("empty", str(ctx.exception).lower())

    def test_exec_whitespace_only_command_raises_error(self):
        """Test that whitespace-only command raises error."""
        with self.assertRaises(BashExecutionError) as ctx:
            self.tools.exec("   \n\t   ")

        self.assertIn("empty", str(ctx.exception).lower())

    # ── File Operations in Commands ──

    def test_exec_can_create_files_in_workspace(self):
        """Test that commands can create files in workspace."""
        result = self.tools.exec("echo 'content' > test.txt")

        self.assertEqual(result["exit_code"], 0)
        test_file = self.workspace / "test.txt"
        self.assertTrue(test_file.exists())
        self.assertEqual(test_file.read_text().strip(), "content")

    def test_exec_can_read_files_in_workspace(self):
        """Test that commands can read files in workspace."""
        test_file = self.workspace / "input.txt"
        test_file.write_text("test content")

        result = self.tools.exec("cat input.txt")

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("test content", result["stdout"])

    # ── Complex Commands ──

    def test_exec_piped_commands(self):
        """Test commands with pipes."""
        result = self.tools.exec("echo 'hello world' | grep 'world'")

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("world", result["stdout"])

    def test_exec_command_with_redirects(self):
        """Test commands with redirects."""
        result = self.tools.exec("echo 'test' > output.txt && cat output.txt")

        self.assertEqual(result["exit_code"], 0)
        self.assertIn("test", result["stdout"])

    def test_exec_command_with_conditionals(self):
        """Test commands with && and ||."""
        result = self.tools.exec("true && echo 'success'")
        self.assertIn("success", result["stdout"])

        result = self.tools.exec("false || echo 'fallback'")
        self.assertIn("fallback", result["stdout"])

    # ── Error Handling ──

    def test_exec_command_not_found(self):
        """Test handling of command not found."""
        result = self.tools.exec("nonexistent_command_xyz")

        self.assertNotEqual(result["exit_code"], 0)
        self.assertTrue(len(result["stderr"]) > 0)

    def test_exec_syntax_error(self):
        """Test handling of bash syntax errors."""
        result = self.tools.exec("echo 'unclosed quote")

        self.assertNotEqual(result["exit_code"], 0)

    # ── Result Metadata ──

    def test_exec_result_includes_command(self):
        """Test that result includes the executed command."""
        cmd = "echo 'test'"
        result = self.tools.exec(cmd)

        self.assertEqual(result["command"], cmd)

    def test_exec_result_includes_duration(self):
        """Test that result includes execution duration."""
        result = self.tools.exec("sleep 0.1")

        self.assertIn("duration", result)
        self.assertGreater(result["duration"], 0.0)
        self.assertLess(result["duration"], 1.0)  # Should be around 0.1s

    def test_exec_result_includes_cwd(self):
        """Test that result includes working directory."""
        result = self.tools.exec("pwd")

        self.assertIn("cwd", result)
        # Use resolve() to handle symlinks (e.g., /var -> /private/var on macOS)
        self.assertEqual(Path(result["cwd"]).resolve(), self.workspace.resolve())


if __name__ == "__main__":
    unittest.main()
