"""Server-only Panel credentials and a single explicit project configuration."""

import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

PROJECT_KEY = os.environ.get("TENCENT_MEMORY_PROJECT", "")
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", PROJECT_KEY):
    raise ValueError("TENCENT_MEMORY_PROJECT must be an explicit lowercase slug")
CONFIG_DIR = Path(os.environ.get("TENCENT_MEMORY_CONFIG_DIR", "/config"))
C = json.loads((CONFIG_DIR / (PROJECT_KEY + ".json")).read_text())
for field in (
    "name",
    "team_name",
    "base_url",
    "service_id",
    "user_id",
    "user_key",
    "team_id",
    "agent_id",
):
    if not isinstance(C.get(field), str) or not C[field].strip():
        raise ValueError("Missing server configuration: " + field)
C["project_key"] = PROJECT_KEY


def api(path, body):
    request = urllib.request.Request(
        C["base_url"].rstrip("/") + "/api/v1/" + path,
        json.dumps(body, ensure_ascii=False).encode(),
        {
            "Content-Type": "application/json",
            "x-tdai-service-id": C["service_id"],
            "x-tdai-user-key": C["user_key"],
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=50 if path.startswith("knowledge/code-graph/") else 12
        ) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError("Panel HTTP " + str(exc.code)) from None
    if result.get("code") != 0:
        raise RuntimeError("Panel request failed " + str(result.get("code")))
    return result["data"]
