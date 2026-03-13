"""
Sandbox-local browser tools for the native OpenClaw adapter.

The implementation intentionally keeps browser automation inside the guest VM.
Only sandbox-local tabs and files are used; host/browser MCP routes are not
consulted from this tool.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlparse


class BrowserOperationError(Exception):
    """Raised when a browser action fails or is unsupported."""


@dataclass
class BrowserTab:
    target_id: str
    page: Any
    console_messages: List[Dict[str, str]] = field(default_factory=list)


SNAPSHOT_SCRIPT = """
() => {
  const candidates = Array.from(
    document.querySelectorAll(
      'a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable="true"]'
    )
  );
  const elements = [];
  let next = 1;
  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  for (const el of candidates) {
    if (!isVisible(el)) continue;
    let ref = el.getAttribute('data-paddock-ref');
    if (!ref) {
      ref = `e${next++}`;
      el.setAttribute('data-paddock-ref', ref);
    }
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.textContent || '').trim().slice(0, 160),
      label:
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('name') ||
        '',
      type: el.getAttribute('type') || '',
    });
    if (elements.length >= 80) break;
  }

  return {
    title: document.title || '',
    url: location.href,
    text: (document.body?.innerText || '').trim().slice(0, 4000),
    elements,
  };
}
"""


class BrowserTools:
    """OpenClaw-compatible browser tool implemented inside the sandbox."""

    def __init__(
        self,
        workspace_root: str,
        headless: bool = True,
        default_timeout_ms: int = 15000,
        output_dir: Optional[str] = None,
        playwright_factory: Optional[Callable[[], Any]] = None,
    ) -> None:
        self.workspace_root = Path(workspace_root).resolve()
        self.workspace_root.mkdir(parents=True, exist_ok=True)

        self.output_dir = Path(
            output_dir or (self.workspace_root / ".paddock" / "browser")
        )
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.headless = headless
        self.default_timeout_ms = default_timeout_ms
        self._playwright_factory = playwright_factory or self._default_playwright_factory

        self._manager: Optional[Any] = None
        self._playwright: Optional[Any] = None
        self._browser: Optional[Any] = None
        self._context: Optional[Any] = None
        self._tabs: Dict[str, BrowserTab] = {}
        self._current_tab_id: Optional[str] = None
        self._tab_counter = 0
        self._dialog_handlers: Dict[str, Dict[str, Any]] = {}

    def execute(self, args: Dict[str, Any]) -> Dict[str, Any]:
        action = str(args.get("action") or "").strip().lower()
        if not action:
            raise BrowserOperationError("browser action is required")
        self._ensure_local_target(args)

        if action == "status":
            return self._status()
        if action == "start":
            self._ensure_browser_started()
            return self._status()
        if action == "stop":
            self._stop()
            return self._status()
        if action == "profiles":
            return {
                "profiles": [
                    {
                        "id": "sandbox",
                        "label": "Sandbox browser",
                        "default": True,
                        "headless": self.headless,
                        "sandboxLocal": True,
                    }
                ]
            }
        if action == "tabs":
            return {"currentTargetId": self._current_tab_id, "tabs": self._list_tabs()}
        if action == "open":
            return self._open(args)
        if action == "focus":
            tab = self._resolve_tab(str(args.get("targetId") or ""))
            self._current_tab_id = tab.target_id
            return self._tab_payload(tab)
        if action == "close":
            return self._close(args)
        if action == "navigate":
            return self._navigate(args)
        if action == "snapshot":
            return self._snapshot(args)
        if action == "screenshot":
            return self._screenshot(args)
        if action == "console":
            tab = self._resolve_tab(str(args.get("targetId") or self._current_tab_id or ""))
            return {"targetId": tab.target_id, "messages": list(tab.console_messages)}
        if action == "pdf":
            return self._pdf(args)
        if action == "upload":
            return self._upload(args)
        if action == "dialog":
            return self._dialog(args)
        if action == "act":
            return self._act(args)

        raise BrowserOperationError(f"Unsupported browser action: {action}")

    def _default_playwright_factory(self) -> Any:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - exercised in real sandbox
            raise BrowserOperationError(
                "Playwright is not installed in the sandbox runtime."
            ) from exc
        return sync_playwright()

    def _ensure_local_target(self, args: Dict[str, Any]) -> None:
        target = str(args.get("target") or "sandbox").strip().lower()
        if target not in {"", "sandbox"}:
            raise BrowserOperationError(
                f'Browser target "{target}" is outside the sandbox. Use target="sandbox".'
            )

    def _ensure_browser_started(self) -> None:
        if self._browser is not None and self._context is not None:
            return

        manager = self._playwright_factory()
        playwright = manager.start()
        browser = playwright.chromium.launch(
            headless=self.headless,
            args=["--disable-dev-shm-usage"],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            accept_downloads=True,
        )

        self._manager = manager
        self._playwright = playwright
        self._browser = browser
        self._context = context

    def _status(self) -> Dict[str, Any]:
        return {
            "running": self._browser is not None,
            "headless": self.headless,
            "currentTargetId": self._current_tab_id,
            "tabs": self._list_tabs(),
        }

    def _list_tabs(self) -> List[Dict[str, Any]]:
        return [self._tab_payload(tab) for tab in self._tabs.values()]

    def _open(self, args: Dict[str, Any]) -> Dict[str, Any]:
        url = self._read_url(args)
        self._ensure_browser_started()
        assert self._context is not None
        page = self._context.new_page()
        tab = self._register_page(page)
        page.goto(url, wait_until="load", timeout=self.default_timeout_ms)
        return self._tab_payload(tab)

    def _close(self, args: Dict[str, Any]) -> Dict[str, Any]:
        target_id = str(args.get("targetId") or self._current_tab_id or "")
        tab = self._resolve_tab(target_id)
        tab.page.close()
        self._tabs.pop(tab.target_id, None)
        self._dialog_handlers.pop(tab.target_id, None)
        if self._current_tab_id == tab.target_id:
            self._current_tab_id = next(iter(self._tabs.keys()), None)
        return {
            "closed": tab.target_id,
            "currentTargetId": self._current_tab_id,
            "tabs": self._list_tabs(),
        }

    def _navigate(self, args: Dict[str, Any]) -> Dict[str, Any]:
        url = self._read_url(args)
        tab = self._resolve_tab(str(args.get("targetId") or self._current_tab_id or ""))
        tab.page.goto(url, wait_until="load", timeout=self.default_timeout_ms)
        return self._tab_payload(tab)

    def _snapshot(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab = self._resolve_tab(str(args.get("targetId") or self._current_tab_id or ""))
        payload = tab.page.evaluate(SNAPSHOT_SCRIPT)
        if not isinstance(payload, dict):
            raise BrowserOperationError("Browser snapshot returned invalid data")

        elements = payload.get("elements") or []
        lines = []
        for element in elements:
            if not isinstance(element, dict):
                continue
            ref = str(element.get("ref") or "").strip()
            role = str(element.get("role") or "").strip()
            tag = str(element.get("tag") or "element").strip()
            label = str(element.get("label") or element.get("text") or "").strip()
            descriptor = role or tag
            if label:
                lines.append(f'[{ref}] {descriptor} "{label}"')
            else:
                lines.append(f"[{ref}] {descriptor}")

        return {
            "targetId": tab.target_id,
            "title": payload.get("title") or tab.page.title(),
            "url": payload.get("url") or getattr(tab.page, "url", ""),
            "text": payload.get("text") or "",
            "elements": elements,
            "snapshot": "\n".join(lines),
        }

    def _screenshot(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab = self._resolve_tab(str(args.get("targetId") or self._current_tab_id or ""))
        image_type = str(args.get("type") or "png").strip().lower() or "png"
        if image_type not in {"png", "jpeg"}:
            raise BrowserOperationError(f"Unsupported screenshot type: {image_type}")
        path = self._resolve_output_path(args.get("path"), image_type)
        tab.page.screenshot(
            path=str(path),
            full_page=bool(args.get("fullPage")),
            type=image_type,
        )
        return {"targetId": tab.target_id, "path": str(path), "type": image_type}

    def _pdf(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab = self._resolve_tab(str(args.get("targetId") or self._current_tab_id or ""))
        path = self._resolve_output_path(args.get("path"), "pdf")
        tab.page.pdf(path=str(path))
        return {"targetId": tab.target_id, "path": str(path)}

    def _upload(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab = self._resolve_tab(str(args.get("targetId") or self._current_tab_id or ""))
        paths = args.get("paths")
        if not isinstance(paths, list) or not paths:
            raise BrowserOperationError("browser upload requires one or more paths")
        selector = self._selector_for_action(tab, args)
        resolved_paths = [str(self._resolve_workspace_path(str(path))) for path in paths]
        tab.page.locator(selector).set_input_files(resolved_paths)
        return {"targetId": tab.target_id, "uploaded": resolved_paths}

    def _dialog(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab = self._resolve_tab(str(args.get("targetId") or self._current_tab_id or ""))
        config = {
            "accept": bool(args.get("accept")),
            "promptText": args.get("promptText"),
        }
        self._dialog_handlers[tab.target_id] = config
        return {"targetId": tab.target_id, "armed": True, **config}

    def _act(self, args: Dict[str, Any]) -> Dict[str, Any]:
        request = args.get("request")
        if not isinstance(request, dict):
            request = self._read_legacy_act_request(args)
        if not request:
            raise BrowserOperationError("browser act requires request.kind")

        tab = self._resolve_tab(
            str(
                request.get("targetId")
                or args.get("targetId")
                or self._current_tab_id
                or ""
            )
        )
        kind = str(request.get("kind") or "").strip().lower()
        if not kind:
            raise BrowserOperationError("browser act kind is required")

        if kind == "click":
            locator = tab.page.locator(self._selector_for_action(tab, request))
            locator.click(
                button=str(request.get("button") or "left"),
                click_count=2 if request.get("doubleClick") else 1,
                modifiers=request.get("modifiers") or [],
            )
        elif kind == "type":
            locator = tab.page.locator(self._selector_for_action(tab, request))
            text = str(request.get("text") or "")
            if request.get("slowly"):
                locator.type(text, delay=50)
            else:
                locator.fill(text)
        elif kind == "press":
            selector = request.get("ref") or request.get("selector")
            key = str(request.get("key") or "")
            delay = int(request.get("delayMs") or 0)
            if selector:
                tab.page.locator(self._selector_for_action(tab, request)).press(
                    key, delay=delay
                )
            else:
                tab.page.keyboard.press(key, delay=delay)
        elif kind == "hover":
            tab.page.locator(self._selector_for_action(tab, request)).hover()
        elif kind == "select":
            values = request.get("values") or []
            if not isinstance(values, list) or not values:
                raise BrowserOperationError("browser select requires values")
            tab.page.locator(self._selector_for_action(tab, request)).select_option(
                values
            )
        elif kind == "fill":
            fields = request.get("fields") or []
            if not isinstance(fields, list) or not fields:
                raise BrowserOperationError("browser fill requires fields")
            for field in fields:
                if not isinstance(field, dict):
                    continue
                selector = self._selector_for_action(tab, field)
                text = str(field.get("text") or field.get("value") or "")
                tab.page.locator(selector).fill(text)
        elif kind == "resize":
            width = int(request.get("width") or 1280)
            height = int(request.get("height") or 800)
            tab.page.set_viewport_size({"width": width, "height": height})
        elif kind == "wait":
            if request.get("timeMs") is not None:
                tab.page.wait_for_timeout(int(request["timeMs"]))
            elif request.get("selector"):
                tab.page.wait_for_selector(
                    str(request["selector"]),
                    timeout=int(request.get("timeoutMs") or self.default_timeout_ms),
                )
            elif request.get("url"):
                tab.page.wait_for_url(
                    str(request["url"]),
                    timeout=int(request.get("timeoutMs") or self.default_timeout_ms),
                    wait_until=str(request.get("loadState") or "load"),
                )
            else:
                tab.page.wait_for_load_state(
                    str(request.get("loadState") or "load"),
                    timeout=int(request.get("timeoutMs") or self.default_timeout_ms),
                )
        elif kind == "evaluate":
            fn = str(request.get("fn") or "")
            return {"targetId": tab.target_id, "action": kind, "result": tab.page.evaluate(fn)}
        elif kind == "close":
            return self._close({"targetId": tab.target_id})
        else:
            raise BrowserOperationError(f"Unsupported browser act kind: {kind}")

        return {"targetId": tab.target_id, "action": kind}

    def _read_legacy_act_request(self, args: Dict[str, Any]) -> Dict[str, Any]:
        kind = str(args.get("kind") or "").strip().lower()
        if not kind:
            return {}
        request = {"kind": kind}
        for key in (
            "targetId",
            "ref",
            "selector",
            "doubleClick",
            "button",
            "modifiers",
            "text",
            "slowly",
            "key",
            "delayMs",
            "values",
            "fields",
            "width",
            "height",
            "timeMs",
            "url",
            "loadState",
            "timeoutMs",
            "fn",
        ):
            if key in args:
                request[key] = args[key]
        return request

    def _stop(self) -> None:
        if self._context is not None:
            self._context.close()
        if self._browser is not None:
            self._browser.close()
        if self._manager is not None:
            self._manager.stop()

        self._manager = None
        self._playwright = None
        self._browser = None
        self._context = None
        self._tabs.clear()
        self._dialog_handlers.clear()
        self._current_tab_id = None

    def _register_page(self, page: Any) -> BrowserTab:
        self._tab_counter += 1
        target_id = f"tab-{self._tab_counter}"
        tab = BrowserTab(target_id=target_id, page=page)

        def on_console(message: Any) -> None:
            tab.console_messages.append(
                {
                    "type": str(getattr(message, "type", "log")),
                    "text": str(message.text() if callable(getattr(message, "text", None)) else message),
                }
            )

        def on_dialog(dialog: Any) -> None:
            cfg = self._dialog_handlers.get(target_id, {"accept": False, "promptText": None})
            try:
                if cfg.get("accept"):
                    dialog.accept(cfg.get("promptText"))
                else:
                    dialog.dismiss()
            except Exception:
                return

        try:
            page.on("console", on_console)
            page.on("dialog", on_dialog)
        except Exception:
            pass

        self._tabs[target_id] = tab
        self._current_tab_id = target_id
        return tab

    def _resolve_tab(self, target_id: str) -> BrowserTab:
        if not target_id:
            raise BrowserOperationError("browser targetId is required")
        tab = self._tabs.get(target_id)
        if tab is None:
            raise BrowserOperationError(f"Unknown browser targetId: {target_id}")
        return tab

    def _selector_for_action(self, tab: BrowserTab, params: Dict[str, Any]) -> str:
        ref = str(params.get("ref") or "").strip()
        if ref:
            return f'[data-paddock-ref="{ref}"]'
        selector = str(params.get("selector") or "").strip()
        if selector:
            return selector
        raise BrowserOperationError(
            f'browser action on {tab.target_id} requires ref or selector'
        )

    def _resolve_output_path(self, requested: Any, extension: str) -> Path:
        if requested:
            path = Path(str(requested))
            if not path.is_absolute():
                path = self.output_dir / path
        else:
            path = self.output_dir / f"{int(time.time() * 1000)}.{extension}"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path.resolve()

    def _resolve_workspace_path(self, requested: str) -> Path:
        target = Path(requested)
        if not target.is_absolute():
            target = self.workspace_root / target
        resolved = target.resolve()
        try:
            resolved.relative_to(self.workspace_root)
        except ValueError as exc:
            raise BrowserOperationError(
                f"Path '{requested}' is outside workspace '{self.workspace_root}'"
            ) from exc
        return resolved

    def _read_url(self, args: Dict[str, Any]) -> str:
        url = str(args.get("targetUrl") or args.get("url") or "").strip()
        if not url:
            raise BrowserOperationError("browser url is required")
        if url == "about:blank":
            return url
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise BrowserOperationError(
                f"Unsupported browser URL scheme: {parsed.scheme or 'unknown'}"
            )
        return url

    def _tab_payload(self, tab: BrowserTab) -> Dict[str, Any]:
        return {
            "targetId": tab.target_id,
            "url": getattr(tab.page, "url", ""),
            "title": tab.page.title(),
            "current": tab.target_id == self._current_tab_id,
        }
