#!/usr/bin/env python3
"""Agent Studio — local Python server.

Serves the Agent Studio web app AND the AI endpoint, so the chat works without
exposing your API key in the browser and without any CORS trouble.

    GEMINI_API_KEY=your_key python3 server.py
    # then open http://localhost:8000

Standard library only — no pip install needed. Python 3.9+.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GEMINI_API_BASE = os.environ.get("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")

# --- allow-list, mirroring backend/app/allowlist.py -------------------------
PACKAGE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$")
SETTINGS_RE = re.compile(r"^[A-Za-z0-9_.]+$")

TOOL_DECLARATIONS = [
    {"name": "open_app", "description": "Open an installed Android app by package name.",
     "parameters": {"type": "object", "properties": {"package_name": {"type": "string"}}, "required": ["package_name"]}},
    {"name": "open_settings", "description": "Open a supported Android settings action.",
     "parameters": {"type": "object", "properties": {"action": {"type": "string"}}, "required": ["action"]}},
    {"name": "back", "description": "Perform Android back via AccessibilityService when enabled.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "home", "description": "Perform Android home via AccessibilityService when enabled.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "share_text", "description": "Open Android share sheet with text.",
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "clipboard_set", "description": "Write text to the Android clipboard.",
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
]
ALLOWED_NAMES = {t["name"] for t in TOOL_DECLARATIONS}


def validate_tool(name: str, args: dict) -> dict:
    """Raise ValueError unless the tool and its arguments pass the allow-list."""
    if name not in ALLOWED_NAMES:
        raise ValueError(f"Tool not allowed: {name}")
    args = args or {}
    expected = {
        "open_app": {"package_name"},
        "open_settings": {"action"},
        "back": set(),
        "home": set(),
        "share_text": {"text"},
        "clipboard_set": {"text"},
    }[name]
    extra = set(args) - expected
    if extra:
        raise ValueError(f"Unexpected argument(s) for {name}: {', '.join(sorted(extra))}")
    if name == "open_app":
        pkg = args.get("package_name")
        if not isinstance(pkg, str) or not PACKAGE_RE.match(pkg):
            raise ValueError("Invalid package_name")
        return {"package_name": pkg}
    if name == "open_settings":
        act = args.get("action")
        if not isinstance(act, str) or not (1 <= len(act) <= 120) or not SETTINGS_RE.match(act):
            raise ValueError("Invalid settings action")
        return {"action": act}
    if name in ("back", "home"):
        return {}
    if name in ("share_text", "clipboard_set"):
        text = args.get("text")
        limit = 5000 if name == "share_text" else 10000
        if not isinstance(text, str) or len(text) > limit or (name == "share_text" and not text):
            raise ValueError(f"Invalid text for {name}")
        return {"text": text}
    raise ValueError(f"Tool not allowed: {name}")


SYSTEM_PROMPT = (
    "You are an Android task planner. Reply briefly and helpfully. Choose only declared tools. "
    "Never invent permissions or capabilities. For app launching, return an actual Android package "
    "name only when you can infer one confidently; otherwise ask the user to provide it."
)


def gemini_chat(message: str, model: str, history: list) -> dict:
    """Call Gemini and return {"reply": str, "tool_call": {...} | None}."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set. Restart the server with your key.")

    contents = []
    for m in (history or [])[-12:]:
        role = "model" if m.get("role") == "model" else "user"
        text = str(m.get("text", ""))[:8000]
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})
    if not contents or contents[-1]["parts"][0]["text"] != message:
        contents.append({"role": "user", "parts": [{"text": message}]})

    body = {
        "contents": contents,
        "tools": [{"function_declarations": TOOL_DECLARATIONS}],
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
    }
    url = f"{GEMINI_API_BASE}/models/{urllib.parse.quote(model)}:generateContent"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        try:
            detail = json.loads(detail).get("error", {}).get("message", detail)
        except Exception:
            pass
        raise RuntimeError(f"Gemini error {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach Gemini: {e.reason}")

    parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts")) or []
    for part in parts:
        fc = part.get("functionCall")
        if fc:
            name = fc.get("name", "")
            if name not in ALLOWED_NAMES:
                return {"reply": "Model requested an unsupported action.", "tool_call": None}
            try:
                safe = validate_tool(name, fc.get("args") or {})
            except ValueError as exc:
                return {"reply": f"Planned tool rejected by the allow-list: {exc}", "tool_call": None}
            return {"reply": f"Planned action: {name}", "tool_call": {"name": name, "args": safe}}
    text = "".join(p.get("text", "") for p in parts).strip()
    return {"reply": text or "No response returned.", "tool_call": None}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, code: int, payload: dict):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            return self._json(200, {"status": "ok", "server": "agent-studio",
                                    "model": DEFAULT_MODEL,
                                    "gemini_key": bool(os.environ.get("GEMINI_API_KEY", "").strip())})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/chat":
            return self._json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            return self._json(400, {"error": "Invalid JSON body"})
        message = str(body.get("message", "")).strip()
        if not message:
            return self._json(400, {"error": "Empty message"})
        model = str(body.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
        try:
            result = gemini_chat(message[:8000], model, body.get("history") or [])
            return self._json(200, result)
        except RuntimeError as exc:
            return self._json(502, {"error": str(exc)})
        except Exception as exc:  # never leak a traceback to the client
            return self._json(500, {"error": f"Server error: {type(exc).__name__}"})


def main() -> None:
    port = 8000
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a in ("--port", "-p") and i + 1 < len(args):
            port = int(args[i + 1])
    if not os.environ.get("GEMINI_API_KEY", "").strip():
        print("! GEMINI_API_KEY is not set — the chat will reply with a clear error until you set it.")
        print("  Example:  GEMINI_API_KEY=your_key python3 server.py")
    print(f"Agent Studio running at http://localhost:{port}  (model: {DEFAULT_MODEL})")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
