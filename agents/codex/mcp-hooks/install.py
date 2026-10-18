#!/usr/bin/env python3
"""Install only adapter files and its MCP/Hook entries; never change model/login."""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile
import tomllib

SOURCE = Path(__file__).resolve().parent
EVENTS = {
    "UserPromptSubmit": (60, "检索项目长期记忆"),
    "Stop": (50, "保存项目长期记忆"),
    "SubagentStart": (50, "继承父会话团队资产绑定"),
    "SubagentStop": (50, "归档子 Agent 最终结果"),
}


def hook_config(existing, command):
    """Preserve unrelated event groups and update only our command entries."""
    data = json.loads(json.dumps(existing))
    hooks = data.setdefault("hooks", {})
    for event, (timeout, message) in EVENTS.items():
        entry = {
            "type": "command",
            "command": command,
            "timeout": timeout,
            "statusMessage": message,
        }
        if event in ("UserPromptSubmit", "SubagentStart"):
            entry["additionalContextLimit"] = 12000
        groups = hooks.setdefault(event, [])
        found = False
        for group in groups:
            for old in group.get("hooks", []):
                if old.get("command") == command:
                    old.update(entry)
                    found = True
        if not found:
            groups.append({"hooks": [entry]})
    return data


def mcp_config(text, python, launcher, project_dir, name):
    data = tomllib.loads(text)
    fields = {
        "command": python,
        "args": [str(launcher)],
        "startup_timeout_sec": 60,
        "tool_timeout_sec": 65,
    }
    if project_dir:
        fields["cwd"] = str(project_dir)
    existing = data.get("mcp_servers", {}).get(name)
    if existing is not None:
        # Existing adapter entries remain untouched, including operator overrides.
        if existing.get("command") != python or existing.get("args") != fields["args"]:
            raise ValueError("MCP entry already exists for another command: " + name)
        if project_dir and existing.get("cwd") != str(project_dir):
            raise ValueError("Existing MCP cwd differs; edit that entry explicitly")
        return text
    table = "\n\n# TencentDB Memory MCP + Hooks\n[mcp_servers." + name + "]\n"
    table += "".join(
        key + " = " + json.dumps(value, ensure_ascii=False) + "\n"
        for key, value in fields.items()
    )
    result = text.rstrip() + table
    tomllib.loads(result)
    return result


def atomic_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(payload)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(codex_home, destination, project_dir=None, name="team_assets"):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise ValueError("Invalid MCP server name")
    python = str(Path(sys.executable).resolve())
    command = shlex.join([python, str(destination / "hook.py")])
    config_path, hooks_path = codex_home / "config.toml", codex_home / "hooks.json"
    old_toml = config_path.read_text() if config_path.exists() else ""
    old_hooks = json.loads(hooks_path.read_text()) if hooks_path.exists() else {}
    # Validate both before changing any files.
    new_toml = mcp_config(
        old_toml, python, destination / "mcp-launcher.py", project_dir, name
    )
    new_hooks = hook_config(old_hooks, command)
    changes = {
        destination / p.name: p.read_bytes() for p in (SOURCE / "local").glob("*.py")
    }
    changes[config_path] = new_toml.encode()
    changes[hooks_path] = (
        json.dumps(new_hooks, ensure_ascii=False, indent=2) + "\n"
    ).encode()
    if not (destination / "projects.json").exists():
        changes[destination / "projects.json"] = (
            SOURCE / "examples/projects.json"
        ).read_bytes()
    changes = {
        path: content
        for path, content in changes.items()
        if not path.exists() or path.read_bytes() != content
    }
    if not changes:
        return None
    backup = (
        codex_home
        / "backups"
        / ("memory-mcp-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    )
    backup.mkdir(parents=True, mode=0o700)
    # Record original paths so recovery never depends on basename guesses.
    manifest = []
    for index, path in enumerate(changes):
        copy = str(index)
        existed = path.exists()
        if existed:
            shutil.copyfile(path, backup / copy)
            (backup / copy).chmod(0o600)
        manifest.append(
            {"path": str(path), "existed": existed, "backup": copy if existed else None}
        )
    atomic_write(backup / "manifest.json", json.dumps(manifest, indent=2).encode())
    for path, content in changes.items():
        atomic_write(path, content)
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")),
    )
    parser.add_argument("--install-dir", type=Path)
    parser.add_argument(
        "--project-dir",
        type=Path,
        help="Pin MCP cwd; use the same project directory as projects.json",
    )
    parser.add_argument("--server-name", default="team_assets")
    args = parser.parse_args()
    codex_home = args.codex_home.expanduser().resolve()
    destination = (
        (args.install_dir or codex_home / "tencent-memory").expanduser().resolve()
    )
    project_dir = args.project_dir.expanduser().resolve() if args.project_dir else None
    if project_dir and not project_dir.is_dir():
        parser.error("--project-dir must exist")
    backup = install(codex_home, destination, project_dir, args.server_name)
    print(
        "Installed. Backup: " + str(backup)
        if backup
        else "Already installed; no changes."
    )
    print(
        "Configure "
        + str(destination / "projects.json")
        + ", then restart the client MCP/Hook runtime."
    )


if __name__ == "__main__":
    os.umask(0o077)
    main()
