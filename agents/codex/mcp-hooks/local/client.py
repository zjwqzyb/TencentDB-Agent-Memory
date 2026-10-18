"""Project routing and credential redaction. Configuration is trusted local input."""

import json
import os
import pathlib
import re
import subprocess
import sys

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
        for field in ("name", "team", "agent", "config_file"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError("Missing project configuration: " + field)
        if item.get("transport", "http") != "http":
            raise ValueError("Only direct Panel HTTP transport is supported")
        config = pathlib.Path(item["config_file"])
        if not config.is_absolute() or config.name != key + ".json":
            raise ValueError("config_file must be an absolute path ending in <key>.json")
        resolved = path.resolve()
        if actual.is_relative_to(resolved):
            matches.append((len(resolved.parts), resolved, item))
    if not matches:
        return None
    matches.sort(key=lambda match: match[0], reverse=True)
    if len(matches) > 1 and matches[0][1] == matches[1][1]:
        raise ValueError("Ambiguous project directory")
    return matches[0][2]


def runtime(p, mode):
    """Run the shared adapter locally; credentials never enter command arguments."""
    key = p["key"]
    if not KEY_PATTERN.fullmatch(key):
        raise ValueError("Invalid project key")
    config = pathlib.Path(p["config_file"])
    if not config.is_absolute() or config.name != key + ".json":
        raise ValueError("Invalid project config_file")
    if not config.is_file():
        raise ValueError("Panel configuration missing; configure or migrate this project")
    program = {"mcp": "server.py", "bridge": "project-memory-bridge.py"}[mode]
    script = ROOT / "runtime" / program
    if not script.is_file():
        raise ValueError("Local runtime missing; rerun the adapter installer")
    folder = STATE / key
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    env = dict(
        os.environ,
        TENCENT_MEMORY_PROJECT=key,
        TENCENT_MEMORY_CONFIG_DIR=str(config.parent),
        TENCENT_MEMORY_STATE_DIR=str(folder),
    )
    return [sys.executable, "-B", str(script), key], env


def remote(p, request):
    # Retain the public helper name for existing Hook integrations.
    command, env = runtime(p, "bridge")
    result = subprocess.run(
        command,
        env=env,
        input=json.dumps(request, ensure_ascii=False),
        text=True,
        capture_output=True,
        timeout=22,
    )
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("Local Panel adapter unavailable") from None
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
