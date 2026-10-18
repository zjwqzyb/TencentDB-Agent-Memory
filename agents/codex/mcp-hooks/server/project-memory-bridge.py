"""One local Hook request over stdin. No legacy/unpinned capture fallback."""

import json
import os
import sys
os.umask(0o077)
from project_runtime import run

if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("Request too large")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("Request must be an object")
        print(json.dumps({"ok": True, "data": run(request)}, ensure_ascii=False))
    except Exception as exc:
        message = (
            str(exc)
            if isinstance(exc, (ValueError, RuntimeError))
            else type(exc).__name__
        )
        print(json.dumps({"ok": False, "error": message}))
        sys.exit(1)
