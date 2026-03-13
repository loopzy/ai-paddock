"""
Unit tests for sandbox-local browser tools.

These tests exercise the OpenClaw-compatible browser action surface without
requiring a real browser installation by using a fake Playwright backend.
"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from paddock_amp.tools.browser_tools import BrowserOperationError, BrowserTools


class FakeConsoleMessage:
    def __init__(self, text: str, msg_type: str = "log") -> None:
        self._text = text
        self.type = msg_type

    def text(self) -> str:
        return self._text


class FakePage:
    def __init__(self) -> None:
        self.url = "about:blank"
        self._title = "Blank"
        self.viewport = {"width": 1280, "height": 800}
        self.handlers = {}
        self.closed = False
        self.last_goto_timeout = None
        self.last_locator = None
        self.last_evaluate = None
        self.wait_events = []
        self.uploaded_paths = []
        self.console_messages = [FakeConsoleMessage("page loaded")]

    def on(self, event_name, handler):
        self.handlers[event_name] = handler
        if event_name == "console":
            for message in self.console_messages:
                handler(message)

    def goto(self, url: str, wait_until: str = "load", timeout: int = 0):
        self.url = url
        self._title = f"Title for {url}"
        self.last_goto_timeout = timeout
        return {"url": url, "waitUntil": wait_until, "timeout": timeout}

    def title(self) -> str:
        return self._title

    def close(self) -> None:
        self.closed = True

    def set_viewport_size(self, viewport):
        self.viewport = dict(viewport)

    def wait_for_timeout(self, timeout_ms: int):
        self.wait_events.append(("timeout", timeout_ms))

    def wait_for_selector(self, selector: str, timeout: int = 0):
        self.wait_events.append(("selector", selector, timeout))

    def wait_for_url(self, url: str, timeout: int = 0, wait_until: str = "load"):
        self.wait_events.append(("url", url, timeout, wait_until))

    def wait_for_load_state(self, state: str = "load", timeout: int = 0):
        self.wait_events.append(("load_state", state, timeout))

    def evaluate(self, script: str):
        self.last_evaluate = script
        return {
            "title": self._title,
            "url": self.url,
            "text": "Welcome to Example",
            "elements": [
                {
                    "ref": "e1",
                    "tag": "button",
                    "role": "button",
                    "text": "Search",
                    "label": "Search",
                }
            ],
        }

    def locator(self, selector: str):
        self.last_locator = selector
        return FakeLocator(selector, self)

    def screenshot(self, path: str, full_page: bool = False, type: str = "png"):
        Path(path).write_bytes(b"fake-image")
        return b"fake-image"

    def pdf(self, path: str):
        Path(path).write_bytes(b"%PDF-1.4 fake")

    @property
    def keyboard(self):
        return FakeKeyboard(self)


class FakeKeyboard:
    def __init__(self, page: FakePage) -> None:
        self.page = page

    def press(self, key: str, delay: int = 0):
        self.page.wait_events.append(("key", key, delay))


class FakeLocator:
    def __init__(self, selector: str, page: FakePage) -> None:
        self.selector = selector
        self.page = page
        self.calls = []

    def click(self, button: str = "left", click_count: int = 1, modifiers=None):
        self.calls.append(("click", button, click_count, tuple(modifiers or [])))

    def fill(self, text: str):
        self.calls.append(("fill", text))

    def type(self, text: str, delay: int = 0):
        self.calls.append(("type", text, delay))

    def hover(self):
        self.calls.append(("hover",))

    def press(self, key: str, delay: int = 0):
        self.calls.append(("press", key, delay))

    def select_option(self, values):
        self.calls.append(("select_option", tuple(values)))

    def set_input_files(self, paths):
        self.page.uploaded_paths = list(paths)
        self.calls.append(("set_input_files", tuple(paths)))


class FakeContext:
    def __init__(self) -> None:
        self.pages = []

    def new_page(self) -> FakePage:
        page = FakePage()
        self.pages.append(page)
        return page

    def close(self) -> None:
        for page in self.pages:
            page.close()


class FakeBrowser:
    def __init__(self) -> None:
        self.contexts = []
        self.closed = False

    def new_context(self, viewport=None, accept_downloads=True):
        context = FakeContext()
        self.contexts.append((context, viewport, accept_downloads))
        return context

    def close(self) -> None:
        self.closed = True


class FakeChromium:
    def __init__(self) -> None:
        self.launch_calls = []
        self.browser = FakeBrowser()

    def launch(self, headless: bool = True, args=None):
        self.launch_calls.append({"headless": headless, "args": list(args or [])})
        return self.browser


class FakePlaywright:
    def __init__(self) -> None:
        self.chromium = FakeChromium()


class FakePlaywrightManager:
    def __init__(self) -> None:
        self.playwright = FakePlaywright()
        self.started = False
        self.stopped = False

    def start(self) -> FakePlaywright:
        self.started = True
        return self.playwright

    def stop(self) -> None:
        self.stopped = True


class BrowserToolsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir) / "workspace"
        self.workspace.mkdir()
        self.manager = FakePlaywrightManager()
        self.tools = BrowserTools(
            workspace_root=str(self.workspace),
            headless=True,
            default_timeout_ms=7500,
            playwright_factory=lambda: self.manager,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_status_is_idle_before_start(self) -> None:
        result = self.tools.execute({"action": "status"})
        self.assertFalse(result["running"])
        self.assertEqual(result["tabs"], [])

    def test_start_and_profiles_expose_local_sandbox_browser(self) -> None:
        result = self.tools.execute({"action": "start"})
        self.assertTrue(result["running"])
        self.assertTrue(self.manager.started)
        launch_call = self.manager.playwright.chromium.launch_calls[0]
        self.assertTrue(launch_call["headless"])

        profiles = self.tools.execute({"action": "profiles"})
        self.assertEqual(profiles["profiles"][0]["id"], "sandbox")
        self.assertTrue(profiles["profiles"][0]["sandboxLocal"])

    def test_open_snapshot_and_act_use_snapshot_refs(self) -> None:
        open_result = self.tools.execute({"action": "open", "url": "https://example.com"})
        self.assertTrue(open_result["targetId"].startswith("tab-"))
        self.assertEqual(open_result["url"], "https://example.com")

        snapshot = self.tools.execute({"action": "snapshot", "targetId": open_result["targetId"]})
        self.assertEqual(snapshot["elements"][0]["ref"], "e1")
        self.assertIn("[e1]", snapshot["snapshot"])

        act = self.tools.execute(
            {
                "action": "act",
                "targetId": open_result["targetId"],
                "request": {"kind": "click", "ref": "e1"},
            }
        )
        self.assertEqual(act["action"], "click")
        page = self.tools._resolve_tab(open_result["targetId"]).page  # noqa: SLF001
        self.assertEqual(page.last_locator, '[data-paddock-ref="e1"]')

    def test_screenshot_and_pdf_write_under_workspace(self) -> None:
        open_result = self.tools.execute({"action": "open", "url": "https://example.com"})

        screenshot = self.tools.execute({"action": "screenshot", "targetId": open_result["targetId"]})
        screenshot_path = Path(screenshot["path"])
        self.assertTrue(screenshot_path.exists())
        self.assertTrue(screenshot_path.is_file())
        self.assertTrue(str(screenshot_path).startswith(str(self.workspace.resolve())))

        pdf = self.tools.execute({"action": "pdf", "targetId": open_result["targetId"]})
        pdf_path = Path(pdf["path"])
        self.assertTrue(pdf_path.exists())
        self.assertTrue(str(pdf_path).startswith(str(self.workspace.resolve())))

    def test_upload_requires_workspace_paths(self) -> None:
        open_result = self.tools.execute({"action": "open", "url": "https://example.com"})
        upload_file = self.workspace / "upload.txt"
        upload_file.write_text("payload")

        result = self.tools.execute(
            {
                "action": "upload",
                "targetId": open_result["targetId"],
                "ref": "e1",
                "paths": ["upload.txt"],
            }
        )

        self.assertEqual(result["uploaded"], [str(upload_file.resolve())])

        with self.assertRaises(BrowserOperationError):
            self.tools.execute(
                {
                    "action": "upload",
                    "targetId": open_result["targetId"],
                    "ref": "e1",
                    "paths": ["/etc/passwd"],
                }
            )

    def test_rejects_host_target_and_unsafe_navigation_schemes(self) -> None:
        with self.assertRaises(BrowserOperationError):
            self.tools.execute({"action": "status", "target": "host"})

        with self.assertRaises(BrowserOperationError):
            self.tools.execute({"action": "open", "url": "file:///etc/passwd"})


if __name__ == "__main__":
    unittest.main()
