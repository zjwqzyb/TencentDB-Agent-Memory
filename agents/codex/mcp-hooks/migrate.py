#!/usr/bin/env python3
"""Import an offline SSH-adapter snapshot into a direct HTTP installation.

Stop/quiesce old writers before taking the snapshot. No network connections are
made here. Existing Hook queues are retained and runtime databases never replaced.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
from urllib.parse import urlsplit

from install import atomic_write


def migrate(destination, key, config_file, snapshot, panel_url, state_dir=None):
    destination = Path(destination).resolve()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", key):
        raise ValueError("Invalid project key")
    url = urlsplit(panel_url)
    if (url.scheme not in ("http", "https") or not url.hostname
            or url.username is not None or url.password is not None
            or url.query or url.fragment):
        raise ValueError("Use the directly reachable Panel HTTP(S) root URL")
    config = json.loads(Path(config_file).read_text())
    for field in ("name", "team_name", "service_id", "user_id", "user_key", "team_id", "agent_id"):
        if not isinstance(config.get(field), str) or not config[field].strip():
            raise ValueError("Missing Panel configuration: " + field)
    config["base_url"] = panel_url.rstrip("/")
    projects = destination / "projects.json"
    mapping = json.loads(projects.read_text())
    selected = [p for p in mapping["projects"] if p.get("key") == key]
    if len(selected) != 1:
        raise ValueError("Exactly one existing project mapping is required")
    state_root = Path(state_dir or os.environ.get("TENCENT_MEMORY_STATE_DIR", destination / "state")).expanduser().resolve()
    state = state_root / key
    target = state / "runtime.sqlite3"
    if target.exists():
        raise ValueError("Runtime already exists; refuse to replace binding/ledger state")
    snapshot = Path(snapshot).resolve()
    if not snapshot.is_file():
        raise ValueError("Runtime snapshot missing")
    # Open the exported snapshot read-only; backup handles WAL consistently.
    with sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True) as source:
        if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Runtime snapshot integrity check failed")
        expected = {"sessions", "bindings", "transitions", "writes", "slices", "subagents"}
        tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not expected <= tables:
            raise ValueError("Snapshot is not a v3 adapter runtime database")
        for (raw,) in source.execute("SELECT data FROM bindings"):
            if json.loads(raw)["team_id"] != config["team_id"]:
                raise ValueError("Snapshot belongs to a different team")
        for (team,) in source.execute("SELECT DISTINCT team_id FROM sessions WHERE team_id IS NOT NULL"):
            if team != config["team_id"]:
                raise ValueError("Snapshot belongs to a different team")
        # Migration must not import source-side write barriers or arbitrary triggers.
        if source.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]:
            raise ValueError("Export a clean snapshot without source-side migration guards")
        config_target = destination / "config" / (key + ".json")
        backup = destination / "backups" / ("http-" + key + "-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
        backup.mkdir(parents=True, mode=0o700)
        manifest = []
        for i, path in enumerate((projects, config_target, target)):
            existed = path.exists()
            if existed:
                shutil.copyfile(path, backup / str(i))
                (backup / str(i)).chmod(0o600)
            manifest.append({"path": str(path), "existed": existed, "backup": str(i) if existed else None})
        atomic_write(backup / "manifest.json", json.dumps(manifest, indent=2).encode())
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        config_target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=".runtime-", dir=state)
        os.close(fd)
        try:
            with sqlite3.connect(temporary) as copied:
                source.backup(copied)
            atomic_write(config_target, (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode())
            os.replace(temporary, target)
            selected[0].update(transport="http", config_file=str(config_target))
            for field in ("ssh_host", "mcp_command", "bridge_command"):
                selected[0].pop(field, None)
            # Switch routing last, after both credentials and state are durable.
            atomic_write(projects, (json.dumps(mapping, ensure_ascii=False, indent=2) + "\n").encode())
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", type=Path, default=Path.home() / ".codex/tencent-memory")
    parser.add_argument("--project-key", required=True)
    parser.add_argument("--config-file", type=Path, required=True, help="Private exported Panel config")
    parser.add_argument("--runtime-db", type=Path, required=True, help="Consistent offline runtime snapshot")
    parser.add_argument("--panel-url", required=True)
    parser.add_argument("--state-dir", type=Path, help="Shared state root; defaults to TENCENT_MEMORY_STATE_DIR or <install-dir>/state")
    args = parser.parse_args()
    backup = migrate(args.install_dir, args.project_key, args.config_file, args.runtime_db, args.panel_url, args.state_dir)
    print("Migrated. Backup: " + str(backup))


if __name__ == "__main__":
    os.umask(0o077)
    main()
