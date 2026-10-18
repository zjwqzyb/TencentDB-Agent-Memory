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


class PanelError(RuntimeError):
    """Expose a safe status category, never a raw response body or credentials."""

    def __init__(self, code):
        self.code = code
        self.definite_rejection = code in (400, 401, 403, 404, 409, 422)
        message = "Panel request failed " + str(code)
        if code == 409:
            message += "; task revision conflict: reload, review changes and use a new request_id; no automatic retry"
        elif code in (400, 422):
            message += (
                "; check fields, acceptance/evidence, blockers and subtask completion"
            )
        super().__init__(message)


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
        raise PanelError(exc.code) from None
    if result.get("code") != 0:
        raise PanelError(result.get("code"))
    return result["data"]
