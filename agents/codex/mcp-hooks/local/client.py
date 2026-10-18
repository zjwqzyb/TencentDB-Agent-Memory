"""Project routing and credential redaction. Configuration is trusted local input."""

import json
import os
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
CONFIG = pathlib.Path(os.environ.get("TENCENT_MEMORY_PROJECTS", ROOT / "projects.json"))
STATE = pathlib.Path(os.environ.get("TENCENT_MEMORY_STATE_DIR", ROOT / "state"))
KEY_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")


def project(cwd):
    """Match the deepest resolved directory, never an unrelated/default project."""
    if not isinstance(cwd, str) or not pathlib.Path(cwd).is_absolute():
        return None
    if not CONFIG.exists():
        return None
    actual = pathlib.Path(cwd).resolve()
    matches = []
    keys = set()
    for item in json.loads(CONFIG.read_text())["projects"]:
        key = item.get("key", "")
        if not KEY_PATTERN.fullmatch(key) or key in keys:
            raise ValueError("Project keys must be unique lowercase slugs")
        keys.add(key)
        if not item.get("enabled"):
            continue
        path = pathlib.Path(item["path"])
        if not path.is_absolute():
            raise ValueError("Project paths must be absolute")
        host = item["ssh_host"]
        if (
            not isinstance(host, str)
            or not re.fullmatch(r"[A-Za-z0-9_@.:-]+", host)
            or host.startswith("-")
        ):
            raise ValueError("Invalid SSH host; use an SSH config alias")
        for field in ("name", "team", "agent", "bridge_command", "mcp_command"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError("Missing project configuration: " + field)
        resolved = path.resolve()
        if actual.is_relative_to(resolved):
            matches.append((len(resolved.parts), resolved, item))
    if not matches:
        return None
    matches.sort(key=lambda match: match[0], reverse=True)
    if len(matches) > 1 and matches[0][1] == matches[1][1]:
        raise ValueError("Ambiguous project directory")
    return matches[0][2]


def ssh(p, command):
    executable = shutil.which("ssh")
    if not executable:
        raise RuntimeError("OpenSSH client is required")
    return [
        executable,
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        p["ssh_host"],
        command,
    ]


def remote(p, request):
    result = subprocess.run(
        ssh(p, p["bridge_command"]),
        input=json.dumps(request, ensure_ascii=False),
        text=True,
        capture_output=True,
        timeout=22,
    )
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("Memory server unavailable") from None
    if result.returncode or not data.get("ok"):
        raise RuntimeError(data.get("error", "Memory request failed"))
    return data["data"]


def redact(text):
    # Best effort, not a guarantee that arbitrary sensitive content is removed.
    text = re.sub(
        r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        text,
        flags=re.S,
    )
    text = re.sub(
        r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,})\b",
        "[REDACTED KEY]",
        text,
    )
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}", r"\1[REDACTED]", text)
    return re.sub(
        r"(?im)((?:api[_ -]?key|user[_ -]?key|access[_ -]?token|password|密码|密钥)\s*[=:：]\s*)[^\s,;，；]+",
        r"\1[REDACTED]",
        text,
    )
