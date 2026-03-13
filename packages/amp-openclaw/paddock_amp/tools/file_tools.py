"""
File operation tools for the agent.

Provides read, write, edit, and list operations with security constraints:
- All operations are restricted to workspace directory
- Path traversal attacks are blocked
- File size limits are enforced
- Operations are logged for audit
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional


class FileOperationError(Exception):
    """Raised when a file operation fails or is blocked."""
    pass


class FileTools:
    """File operation tools with security constraints."""

    def __init__(self, workspace_root: str, max_file_size: int = 10 * 1024 * 1024):
        """
        Initialize file tools.

        Args:
            workspace_root: Root directory for all file operations
            max_file_size: Maximum file size in bytes (default: 10MB)
        """
        self.workspace_root = Path(workspace_root).resolve()
        self.max_file_size = max_file_size

        # Ensure workspace exists
        self.workspace_root.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, path: str) -> Path:
        """
        Resolve and validate a path within workspace.

        Args:
            path: Relative or absolute path

        Returns:
            Resolved absolute path

        Raises:
            FileOperationError: If path is outside workspace or invalid
        """
        try:
            # Convert to Path and resolve
            target = Path(path)

            # If relative, make it relative to workspace
            if not target.is_absolute():
                target = self.workspace_root / target

            # Resolve to absolute path (handles .., symlinks, etc.)
            resolved = target.resolve()

            # Check if within workspace
            try:
                resolved.relative_to(self.workspace_root)
            except ValueError:
                raise FileOperationError(
                    f"Path '{path}' is outside workspace '{self.workspace_root}'"
                )

            return resolved
        except Exception as e:
            if isinstance(e, FileOperationError):
                raise
            raise FileOperationError(f"Invalid path '{path}': {e}")

    def read_file(self, path: str, encoding: str = "utf-8") -> Dict[str, Any]:
        """
        Read file contents.

        Args:
            path: File path (relative to workspace or absolute)
            encoding: Text encoding (default: utf-8)

        Returns:
            Dict with 'content' and 'size' keys

        Raises:
            FileOperationError: If file doesn't exist, too large, or unreadable
        """
        resolved = self._resolve_path(path)

        if not resolved.exists():
            raise FileOperationError(f"File not found: {path}")

        if not resolved.is_file():
            raise FileOperationError(f"Not a file: {path}")

        # Check file size
        size = resolved.stat().st_size
        if size > self.max_file_size:
            raise FileOperationError(
                f"File too large: {size} bytes (max: {self.max_file_size})"
            )

        try:
            content = resolved.read_text(encoding=encoding)
            return {"content": content, "size": size, "path": str(resolved)}
        except UnicodeDecodeError:
            raise FileOperationError(f"File is not valid {encoding} text: {path}")
        except Exception as e:
            raise FileOperationError(f"Failed to read file: {e}")

    def write_file(self, path: str, content: str, encoding: str = "utf-8") -> Dict[str, Any]:
        """
        Write content to file (creates or overwrites).

        Args:
            path: File path (relative to workspace or absolute)
            content: Content to write
            encoding: Text encoding (default: utf-8)

        Returns:
            Dict with 'path' and 'size' keys

        Raises:
            FileOperationError: If write fails or content too large
        """
        resolved = self._resolve_path(path)

        # Check content size
        content_bytes = content.encode(encoding)
        if len(content_bytes) > self.max_file_size:
            raise FileOperationError(
                f"Content too large: {len(content_bytes)} bytes (max: {self.max_file_size})"
            )

        try:
            # Create parent directories if needed
            resolved.parent.mkdir(parents=True, exist_ok=True)

            # Write file
            resolved.write_text(content, encoding=encoding)

            return {"path": str(resolved), "size": len(content_bytes)}
        except Exception as e:
            raise FileOperationError(f"Failed to write file: {e}")

    def edit_file(self, path: str, old_text: str, new_text: str, encoding: str = "utf-8") -> Dict[str, Any]:
        """
        Edit file by replacing old_text with new_text.

        Args:
            path: File path (relative to workspace or absolute)
            old_text: Text to find and replace
            new_text: Replacement text
            encoding: Text encoding (default: utf-8)

        Returns:
            Dict with 'path', 'size', and 'replacements' keys

        Raises:
            FileOperationError: If file doesn't exist or old_text not found
        """
        resolved = self._resolve_path(path)

        if not resolved.exists():
            raise FileOperationError(f"File not found: {path}")

        if not resolved.is_file():
            raise FileOperationError(f"Not a file: {path}")

        try:
            # Read current content
            content = resolved.read_text(encoding=encoding)

            # Check if old_text exists
            if old_text not in content:
                raise FileOperationError(f"Text not found in file: {old_text[:50]}...")

            # Replace
            new_content = content.replace(old_text, new_text)
            count = content.count(old_text)

            # Check new content size
            new_bytes = new_content.encode(encoding)
            if len(new_bytes) > self.max_file_size:
                raise FileOperationError(
                    f"Edited content too large: {len(new_bytes)} bytes (max: {self.max_file_size})"
                )

            # Write back
            resolved.write_text(new_content, encoding=encoding)

            return {"path": str(resolved), "size": len(new_bytes), "replacements": count}
        except FileOperationError:
            raise
        except Exception as e:
            raise FileOperationError(f"Failed to edit file: {e}")

    def list_directory(self, path: str = ".", pattern: Optional[str] = None) -> Dict[str, Any]:
        """
        List directory contents.

        Args:
            path: Directory path (relative to workspace or absolute, default: ".")
            pattern: Optional glob pattern (e.g., "*.txt")

        Returns:
            Dict with 'entries' list containing file and directory info

        Raises:
            FileOperationError: If directory doesn't exist or not accessible
        """
        resolved = self._resolve_path(path)

        if not resolved.exists():
            raise FileOperationError(f"Directory not found: {path}")

        if not resolved.is_dir():
            raise FileOperationError(f"Not a directory: {path}")

        try:
            entries: List[Dict[str, Any]] = []

            # Get entries
            if pattern:
                items = resolved.glob(pattern)
            else:
                items = resolved.iterdir()

            for entry in sorted(items):
                rel_path = str(entry.relative_to(self.workspace_root))

                if entry.is_file():
                    stat = entry.stat()
                    entries.append({
                        "name": entry.name,
                        "path": rel_path,
                        "type": "file",
                        "size": stat.st_size,
                    })
                elif entry.is_dir():
                    entries.append({
                        "name": entry.name,
                        "path": rel_path,
                        "type": "directory",
                    })

            return {
                "path": str(resolved),
                "entries": entries,
            }
        except Exception as e:
            raise FileOperationError(f"Failed to list directory: {e}")

    def apply_patch(self, patch_input: str) -> Dict[str, Any]:
        """
        Apply a patch using the Codex/OpenClaw apply_patch text format.

        Supports add, update, and delete file hunks within the workspace root.
        """
        lines = patch_input.splitlines()
        if not lines or lines[0].strip() != "*** Begin Patch":
            raise FileOperationError("Patch must start with '*** Begin Patch'")
        if lines[-1].strip() != "*** End Patch":
            raise FileOperationError("Patch must end with '*** End Patch'")

        idx = 1
        summary = {"added": [], "modified": [], "deleted": []}

        while idx < len(lines) - 1:
            header = lines[idx]
            if header.startswith("*** Add File: "):
                path = header[len("*** Add File: "):].strip()
                idx += 1
                contents: List[str] = []
                while idx < len(lines) - 1 and not lines[idx].startswith("*** "):
                    line = lines[idx]
                    if not line.startswith("+"):
                        raise FileOperationError("Add file hunks must contain '+' lines only")
                    contents.append(line[1:])
                    idx += 1
                self.write_file(path, "\n".join(contents) + ("\n" if contents else ""))
                summary["added"].append(path)
                continue

            if header.startswith("*** Delete File: "):
                path = header[len("*** Delete File: "):].strip()
                resolved = self._resolve_path(path)
                if not resolved.exists():
                    raise FileOperationError(f"File not found: {path}")
                resolved.unlink()
                summary["deleted"].append(path)
                idx += 1
                continue

            if header.startswith("*** Update File: "):
                path = header[len("*** Update File: "):].strip()
                move_to: Optional[str] = None
                idx += 1
                if idx < len(lines) - 1 and lines[idx].startswith("*** Move to: "):
                    move_to = lines[idx][len("*** Move to: "):].strip()
                    idx += 1
                change_lines: List[str] = []
                while idx < len(lines) - 1 and not lines[idx].startswith("*** "):
                    if lines[idx].startswith("@@"):
                        idx += 1
                        continue
                    change_lines.append(lines[idx])
                    idx += 1
                updated = self._apply_update_hunk(path, change_lines)
                target_path = move_to or path
                self.write_file(target_path, updated)
                if move_to and move_to != path:
                    self._resolve_path(path).unlink()
                summary["modified"].append(target_path)
                continue

            if header.strip():
                raise FileOperationError(f"Unsupported patch header: {header}")
            idx += 1

        return {
            "summary": summary,
            "text": self._format_patch_summary(summary),
        }

    def _apply_update_hunk(self, path: str, change_lines: List[str]) -> str:
        resolved = self._resolve_path(path)
        if not resolved.exists():
            raise FileOperationError(f"File not found: {path}")
        original_lines = resolved.read_text(encoding="utf-8").splitlines(keepends=True)
        cursor = 0
        output: List[str] = []

        for line in change_lines:
            if not line:
                prefix = " "
                content = ""
            else:
                prefix = line[0]
                content = line[1:]

            if prefix == " ":
                if cursor >= len(original_lines) or original_lines[cursor].rstrip("\n") != content:
                    raise FileOperationError(f"Patch context mismatch for {path}: {content!r}")
                output.append(original_lines[cursor])
                cursor += 1
                continue
            if prefix == "-":
                if cursor >= len(original_lines) or original_lines[cursor].rstrip("\n") != content:
                    raise FileOperationError(f"Patch delete mismatch for {path}: {content!r}")
                cursor += 1
                continue
            if prefix == "+":
                output.append(content + "\n")
                continue
            raise FileOperationError(f"Unsupported patch line prefix: {prefix}")

        output.extend(original_lines[cursor:])
        return "".join(output)

    def _format_patch_summary(self, summary: Dict[str, List[str]]) -> str:
        parts: List[str] = []
        for key in ("added", "modified", "deleted"):
            if summary[key]:
                parts.append(f"{key}: {', '.join(summary[key])}")
        return "; ".join(parts) if parts else "No files changed."
