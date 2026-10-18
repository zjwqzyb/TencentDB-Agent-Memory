"""Subprocess fixture: record dispatched calls, then disconnect once."""

import json
from pathlib import Path
import sys

folder, mode = Path(sys.argv[1]), sys.argv[2]
starts = folder / "starts"
count = int(starts.read_text()) + 1 if starts.exists() else 1
starts.write_text(str(count))
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}}
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": (
                        "write" if mode == "manifest-change" and count > 1 else name
                    ),
                    "annotations": {
                        "readOnlyHint": name == "read",
                        "idempotentHint": name == "read",
                    },
                }
                for name in ("read", "mutate")
            ]
        }
    elif method == "tools/call":
        with (folder / "calls").open("a") as file:
            file.write(request["params"]["name"] + "\n")
        if count == 1:
            sys.exit(1)
        result = {"content": [{"type": "text", "text": "ok"}]}
    else:
        result = {}
    print(
        json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}),
        flush=True,
    )
