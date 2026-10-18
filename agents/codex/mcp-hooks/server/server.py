"""Project MCP server, newline-delimited JSON-RPC over stdio."""

import json
import os
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: server.py PROJECT_KEY")
os.environ["TENCENT_MEMORY_PROJECT"] = sys.argv[1]
from project_api import C
from project_tools import TOOLS, run


def respond(request):
    mid, method = request.get("id"), request.get("method")
    if mid is None:
        return None
    if method == "initialize":
        result = {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {
                "name": "team-assets",
                "title": "团队资产 · " + C["name"],
                "version": "3.0.0",
            },
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        try:
            params = request["params"]
            data = run(params["name"], params.get("arguments", {}))
            result = {
                "content": [
                    {"type": "text", "text": json.dumps(data, ensure_ascii=False)}
                ],
                "isError": False,
            }
        except Exception as exc:
            # Do not return HTTP bodies, credentials, or arbitrary exception internals.
            message = (
                str(exc)
                if isinstance(exc, (ValueError, RuntimeError))
                else type(exc).__name__
            )
            result = {"content": [{"type": "text", "text": message}], "isError": True}
    else:
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "error": {"code": -32601, "message": "Method not found"},
        }
    return {"jsonrpc": "2.0", "id": mid, "result": result}


for line in sys.stdin:
    try:
        request = json.loads(line)
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
            raise ValueError("Invalid JSON-RPC request")
        response = respond(request)
    except (ValueError, TypeError):
        response = {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32700, "message": "Parse error"},
        }
    if response is not None:
        print(json.dumps(response, ensure_ascii=False), flush=True)
