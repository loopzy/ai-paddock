"""
Unit tests for file operation tools.

Tests cover:
- Basic file operations (read, write, edit, list)
- Security constraints (path traversal, file size limits)
- Error handling
- Edge cases
"""

import os
import tempfile
import unittest
from pathlib import Path

from paddock_amp.tools.file_tools import FileTools, FileOperationError


class TestFileTools(unittest.TestCase):
    """Test suite for FileTools."""

    def setUp(self):
        """Create temporary workspace for each test."""
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir) / "workspace"
        self.workspace.mkdir()
        self.tools = FileTools(str(self.workspace), max_file_size=1024)  # 1KB for testing

    def tearDown(self):
        """Clean up temporary workspace."""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # ── Read File Tests ──

    def test_read_file_success(self):
        """Test reading a file successfully."""
        test_file = self.workspace / "test.txt"
        test_content = "Hello, World!"
        test_file.write_text(test_content)

        result = self.tools.read_file("test.txt")

        self.assertEqual(result["content"], test_content)
        self.assertEqual(result["size"], len(test_content))
        self.assertIn("test.txt", result["path"])

    def test_read_file_not_found(self):
        """Test reading non-existent file raises error."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.read_file("nonexistent.txt")
        self.assertIn("not found", str(ctx.exception).lower())

    def test_read_file_too_large(self):
        """Test reading file exceeding size limit raises error."""
        test_file = self.workspace / "large.txt"
        test_file.write_text("x" * 2000)  # Exceeds 1KB limit

        with self.assertRaises(FileOperationError) as ctx:
            self.tools.read_file("large.txt")
        self.assertIn("too large", str(ctx.exception).lower())

    def test_read_file_is_directory(self):
        """Test reading a directory raises error."""
        test_dir = self.workspace / "testdir"
        test_dir.mkdir()

        with self.assertRaises(FileOperationError) as ctx:
            self.tools.read_file("testdir")
        self.assertIn("not a file", str(ctx.exception).lower())

    def test_read_file_absolute_path(self):
        """Test reading file with absolute path."""
        test_file = self.workspace / "absolute.txt"
        test_content = "Absolute path test"
        test_file.write_text(test_content)

        result = self.tools.read_file(str(test_file))

        self.assertEqual(result["content"], test_content)

    def test_read_file_subdirectory(self):
        """Test reading file in subdirectory."""
        subdir = self.workspace / "subdir"
        subdir.mkdir()
        test_file = subdir / "nested.txt"
        test_content = "Nested file"
        test_file.write_text(test_content)

        result = self.tools.read_file("subdir/nested.txt")

        self.assertEqual(result["content"], test_content)

    # ── Write File Tests ──

    def test_write_file_success(self):
        """Test writing a file successfully."""
        result = self.tools.write_file("output.txt", "Test content")

        self.assertIn("output.txt", result["path"])
        self.assertEqual(result["size"], len("Test content"))

        # Verify file was actually written
        written_file = self.workspace / "output.txt"
        self.assertTrue(written_file.exists())
        self.assertEqual(written_file.read_text(), "Test content")

    def test_write_file_creates_parent_dirs(self):
        """Test writing file creates parent directories."""
        result = self.tools.write_file("deep/nested/file.txt", "Content")

        written_file = self.workspace / "deep" / "nested" / "file.txt"
        self.assertTrue(written_file.exists())
        self.assertEqual(written_file.read_text(), "Content")

    def test_write_file_overwrites_existing(self):
        """Test writing overwrites existing file."""
        test_file = self.workspace / "overwrite.txt"
        test_file.write_text("Old content")

        self.tools.write_file("overwrite.txt", "New content")

        self.assertEqual(test_file.read_text(), "New content")

    def test_write_file_content_too_large(self):
        """Test writing content exceeding size limit raises error."""
        large_content = "x" * 2000  # Exceeds 1KB limit

        with self.assertRaises(FileOperationError) as ctx:
            self.tools.write_file("large.txt", large_content)
        self.assertIn("too large", str(ctx.exception).lower())

    # ── Edit File Tests ──

    def test_edit_file_success(self):
        """Test editing a file successfully."""
        test_file = self.workspace / "edit.txt"
        test_file.write_text("Hello World")

        result = self.tools.edit_file("edit.txt", "World", "Python")

        self.assertEqual(result["replacements"], 1)
        self.assertEqual(test_file.read_text(), "Hello Python")

    def test_edit_file_multiple_replacements(self):
        """Test editing replaces all occurrences."""
        test_file = self.workspace / "multi.txt"
        test_file.write_text("foo bar foo baz foo")

        result = self.tools.edit_file("multi.txt", "foo", "qux")

        self.assertEqual(result["replacements"], 3)
        self.assertEqual(test_file.read_text(), "qux bar qux baz qux")

    def test_edit_file_not_found(self):
        """Test editing non-existent file raises error."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.edit_file("nonexistent.txt", "old", "new")
        self.assertIn("not found", str(ctx.exception).lower())

    def test_edit_file_text_not_found(self):
        """Test editing with non-existent text raises error."""
        test_file = self.workspace / "edit.txt"
        test_file.write_text("Hello World")

        with self.assertRaises(FileOperationError) as ctx:
            self.tools.edit_file("edit.txt", "Python", "Java")
        self.assertIn("not found", str(ctx.exception).lower())

    def test_edit_file_result_too_large(self):
        """Test editing that results in file too large raises error."""
        test_file = self.workspace / "edit.txt"
        test_file.write_text("x")

        with self.assertRaises(FileOperationError) as ctx:
            self.tools.edit_file("edit.txt", "x", "y" * 2000)
        self.assertIn("too large", str(ctx.exception).lower())

    # ── List Directory Tests ──

    def test_list_directory_success(self):
        """Test listing directory contents."""
        # Create test files and directories
        (self.workspace / "file1.txt").write_text("content1")
        (self.workspace / "file2.txt").write_text("content2")
        (self.workspace / "subdir").mkdir()
        (self.workspace / "subdir" / "nested.txt").write_text("nested")

        result = self.tools.list_directory(".")

        self.assertEqual(len(result["entries"]), 3)  # file1, file2, subdir
        names = [e["name"] for e in result["entries"]]
        self.assertIn("file1.txt", names)
        self.assertIn("file2.txt", names)
        self.assertIn("subdir", names)

        # Check file vs directory
        file1_entry = next(e for e in result["entries"] if e["name"] == "file1.txt")
        subdir_entry = next(e for e in result["entries"] if e["name"] == "subdir")
        self.assertEqual(file1_entry["type"], "file")
        self.assertEqual(subdir_entry["type"], "directory")

    def test_list_directory_empty(self):
        """Test listing empty directory."""
        empty_dir = self.workspace / "empty"
        empty_dir.mkdir()

        result = self.tools.list_directory("empty")

        self.assertEqual(len(result["entries"]), 0)

    def test_list_directory_not_found(self):
        """Test listing non-existent directory raises error."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.list_directory("nonexistent")
        self.assertIn("not found", str(ctx.exception).lower())

    def test_list_directory_is_file(self):
        """Test listing a file raises error."""
        test_file = self.workspace / "file.txt"
        test_file.write_text("content")

        with self.assertRaises(FileOperationError) as ctx:
            self.tools.list_directory("file.txt")
        self.assertIn("not a directory", str(ctx.exception).lower())

    # ── Apply Patch Tests ──

    def test_apply_patch_updates_file(self):
        """Test applying an update hunk in apply_patch format."""
        test_file = self.workspace / "edit.txt"
        test_file.write_text("hello\nworld\n")

        result = self.tools.apply_patch(
            "*** Begin Patch\n"
            "*** Update File: edit.txt\n"
            "@@\n"
            " hello\n"
            "-world\n"
            "+paddock\n"
            "*** End Patch\n"
        )

        self.assertEqual(test_file.read_text(), "hello\npaddock\n")
        self.assertIn("edit.txt", result["summary"]["modified"])

    def test_apply_patch_adds_file(self):
        """Test applying an add-file patch."""
        result = self.tools.apply_patch(
            "*** Begin Patch\n"
            "*** Add File: notes.txt\n"
            "+hello\n"
            "+world\n"
            "*** End Patch\n"
        )

        self.assertEqual((self.workspace / "notes.txt").read_text(), "hello\nworld\n")
        self.assertIn("notes.txt", result["summary"]["added"])

    # ── Security Tests ──

    def test_path_traversal_blocked_dotdot(self):
        """Test path traversal with .. is blocked."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.read_file("../../../etc/passwd")
        self.assertIn("outside workspace", str(ctx.exception).lower())

    def test_path_traversal_blocked_absolute(self):
        """Test absolute path outside workspace is blocked."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.read_file("/etc/passwd")
        self.assertIn("outside workspace", str(ctx.exception).lower())

    def test_symlink_outside_workspace_blocked(self):
        """Test symlink pointing outside workspace is blocked."""
        # Create symlink to /etc
        symlink = self.workspace / "evil_link"
        try:
            symlink.symlink_to("/etc")
        except OSError:
            self.skipTest("Cannot create symlinks on this system")

        with self.assertRaises(FileOperationError) as ctx:
            self.tools.read_file("evil_link/passwd")
        self.assertIn("outside workspace", str(ctx.exception).lower())

    def test_write_outside_workspace_blocked(self):
        """Test writing outside workspace is blocked."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.write_file("../../../tmp/evil.txt", "malicious")
        self.assertIn("outside workspace", str(ctx.exception).lower())

    def test_edit_outside_workspace_blocked(self):
        """Test editing outside workspace is blocked."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.edit_file("../../../tmp/file.txt", "old", "new")
        self.assertIn("outside workspace", str(ctx.exception).lower())

    def test_list_outside_workspace_blocked(self):
        """Test listing outside workspace is blocked."""
        with self.assertRaises(FileOperationError) as ctx:
            self.tools.list_directory("../../..")
        self.assertIn("outside workspace", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
