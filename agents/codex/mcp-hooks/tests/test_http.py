"""Exercise installed MCP/Hooks over real HTTP without SSH or Docker executables."""

import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from test_local import installer
from test_task_selection import rt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("adapter_migrate", ROOT / "migrate.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class Panel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        s = self.server
        s.calls.append((self.path, body, dict(self.headers)))
        if (self.headers.get("X-Tdai-Service-Id") != "service-secret"
                or self.headers.get("X-Tdai-User-Key") != "user-secret"):
            self.send_error(401)
            return
        if s.fail and (s.fail_route is None or self.path == s.fail_route):
            code = s.fail
            if code == "disconnect":
                # Simulate a native commit followed by a lost HTTP response.
                s.mutations += 1
                s.task["issue"]["revision"] += 1
                self.close_connection = True
                return
            self.send_response(code)
            if code == 302:
                self.send_header("Location", s.url + "/credential-leak")
            self.end_headers()
            self.wfile.write(b"secret error body must never escape")
            return
        route = self.path.removeprefix("/api/v1/")
        if route == "meta/team/get":
            data = {"team_id": "team", "name": "Team", "status": "active"}
        elif route == "meta/team-member/get":
            data = {"status": "active"}
        elif route == "meta/agent/get":
            data = {"agent_id": "agent", "team_id": "team", "owner_user_id": "user", "status": "active", "name": "Agent"}
        elif route in ("meta/task/get", "meta/issue/get"):
            data = copy.deepcopy(s.task)
        elif route == "meta/task-agent/list":
            data = {"items": [{"agent_id": "agent"}]}
        elif route in ("meta/issue/update", "meta/issue/comment"):
            if body["expected_revision"] != s.task["issue"]["revision"]:
                self.send_error(409)
                return
            s.mutations += 1
            s.task.update({k: body[k] for k in ("title", "description") if k in body})
            s.task["issue"].update(body.get("issue", {}))
            s.task["issue"]["revision"] += 1
            data = copy.deepcopy(s.task)
        else:
            data = {"items": [], "total": 0}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"code": 0, "data": data}).encode())


class DirectHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="http adapter ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home, self.dest = self.root / "home", self.root / "adapter"
        installer.install(self.home, self.dest, self.root)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Panel)
        self.server.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.server.calls, self.server.fail, self.server.mutations = [], None, 0
        self.server.fail_route = None
        self.server.task = {"task_id": "task-one", "team_id": "team", "title": "Task", "issue": {"revision": 4}}
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        config_dir = self.dest / "config"
        config_dir.mkdir()
        self.config = dict(name="Project", team_name="Team", base_url=self.server.url,
                           service_id="service-secret", user_key="user-secret", user_id="user", team_id="team", agent_id="agent")
        self.config_file = config_dir / "project.json"
        self.config_file.write_text(json.dumps(self.config))
        self.mapping = {"key": "project", "path": str(self.root), "enabled": True, "name": "Project", "team": "Team", "agent": "Agent", "config_file": str(self.config_file)}
        (self.dest / "projects.json").write_text(json.dumps({"projects": [self.mapping]}))
        self.state = self.dest / "state/project"
        self.state.mkdir(parents=True)
        with patch.object(rt, "DB", str(self.state / "runtime.sqlite3")), rt.db() as db:
            db.execute("INSERT INTO sessions VALUES ('real-session',2,'initialized','team','agent','task-one',0)")
            db.execute("INSERT INTO bindings VALUES ('real-session',2,?)", (json.dumps({"team_id": "team", "agent_id": "agent", "task_id": "task-one"}),))
        self.env = {**os.environ, "PATH": "", "TENCENT_MEMORY_PROJECTS": str(self.dest / "projects.json"), "TENCENT_MEMORY_STATE_DIR": str(self.dest / "state")}

    def bridge(self, **request):
        request = {"session_id": "real-session", **request}
        # Public Hook helper path, with no SSH or Docker available in PATH.
        code = "from client import project, remote; import os,json,sys; print(json.dumps(remote(project(os.getcwd()),json.load(sys.stdin))))"
        return subprocess.run([sys.executable, "-c", code], cwd=self.root,
                              env={**self.env, "PYTHONPATH": str(self.dest)},
                              input=json.dumps(request), text=True, capture_output=True, timeout=10)

    def test_installed_launcher_direct_http_and_generation_preserved(self):
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_project_agent", "arguments": {"session_id": "real-session"}}},
        ]
        result = subprocess.run([sys.executable, str(self.dest / "mcp-launcher.py")], cwd=self.root, env=self.env,
                                input="".join(json.dumps(r) + "\n" for r in requests), text=True, capture_output=True, timeout=10, check=True)
        replies = [json.loads(line)["result"] for line in result.stdout.splitlines()]
        self.assertEqual(replies[0]["serverInfo"]["version"], "3.2.0")
        self.assertEqual(len(replies[1]["tools"]), 14)
        self.assertFalse(replies[2]["isError"])
        context = json.loads(replies[2]["content"][0]["text"])
        self.assertEqual(context["session"]["generation"], 2)
        self.assertEqual(context["session"]["task_id"], "task-one")
        self.assertTrue(self.server.calls)
        self.assertEqual(result.stderr, "")

    def test_hook_and_mcp_share_task_cas_and_durable_deduplication(self):
        request = dict(action="task", operation="update", task_id="task-one", expected_revision=4, title="Updated", request_id="intent-one")
        first = self.bridge(**request)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(first.stdout)["issue"]["revision"], 5)
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "manage_project_task", "arguments": {"session_id": "real-session", **{k: v for k, v in request.items() if k != "action"}}}},
        ]
        repeated = subprocess.run([sys.executable, str(self.dest / "mcp-launcher.py")], cwd=self.root, env=self.env,
                                  input="".join(json.dumps(r) + "\n" for r in requests), text=True, capture_output=True, timeout=10, check=True)
        replay = json.loads(repeated.stdout.splitlines()[-1])["result"]
        self.assertFalse(replay["isError"])
        self.assertTrue(json.loads(replay["content"][0]["text"])["deduplicated"])
        self.assertEqual(self.server.mutations, 1)
        stale = self.bridge(**{**request, "request_id": "intent-two"})
        self.assertNotEqual(stale.returncode, 0)
        self.assertIn("revision conflict", stale.stderr)
        self.assertEqual(self.server.mutations, 1)
        with sqlite3.connect(self.state / "runtime.sqlite3") as db:
            self.assertEqual(db.execute("SELECT status FROM writes WHERE id='intent-one'").fetchone()[0], "done")
            self.assertEqual(db.execute("SELECT status FROM writes WHERE id='intent-two'").fetchone()[0], "rejected")

    def test_lost_http_response_after_commit_is_uncertain_and_never_replayed(self):
        self.server.fail = "disconnect"
        self.server.fail_route = "/api/v1/meta/issue/update"
        request = dict(action="task", operation="update", task_id="task-one", expected_revision=4, title="Update", request_id="lost-response")
        first = self.bridge(**request)
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.server.mutations, 1)
        repeated = self.bridge(**request)
        self.assertNotEqual(repeated.returncode, 0)
        self.assertIn("uncertain outcome", repeated.stderr)
        self.assertEqual(self.server.mutations, 1)
        with sqlite3.connect(self.state / "runtime.sqlite3") as db:
            self.assertEqual(db.execute("SELECT status FROM writes WHERE id='lost-response'").fetchone()[0], "uncertain")

    def test_redirect_and_http_error_do_not_leak_credentials_or_body(self):
        for code in (302, 401, 403):
            self.server.calls.clear()
            self.server.fail = code
            result = self.bridge(action="context")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Panel request failed " + str(code), result.stderr)
            self.assertNotIn("secret", result.stderr + result.stdout)
            self.assertEqual(len(self.server.calls), 1)

    def test_bad_url_and_unknown_working_directory_fail_closed(self):
        self.config["base_url"] = "file:///private/credentials"
        self.config_file.write_text(json.dumps(self.config))
        self.assertNotEqual(self.bridge(action="context").returncode, 0)
        self.assertFalse(self.server.calls)
        mapping = {**self.mapping, "path": str(self.root / "other-project")}
        (self.dest / "projects.json").write_text(json.dumps({"projects": [mapping]}))
        result = subprocess.run([sys.executable, str(self.dest / "mcp-launcher.py")], cwd=self.root, env=self.env, input="", text=True, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No project configured", result.stderr)

    def test_migration_preserves_full_runtime_and_hook_queue_without_overwrite(self):
        source = self.root / "source.sqlite3"
        target = self.state / "runtime.sqlite3"
        with sqlite3.connect(target) as before:
            before.execute("INSERT INTO writes VALUES ('existing','digest','done','{\"ok\":true}',0)")
            before.execute("INSERT INTO slices VALUES ('slice','real-session',2,'[]',0)")
            before.execute("INSERT INTO subagents VALUES ('child','real-session','real-session',2,'{}','default',0)")
            with sqlite3.connect(source) as exported:
                before.commit()
                before.backup(exported)
            original = {name: before.execute('SELECT * FROM "' + name + '"').fetchall() for name in ("sessions", "bindings", "transitions", "writes", "slices", "subagents")}
        target.unlink()
        queue = self.state / "events.sqlite3"
        queue.write_bytes(b"existing-hook-queue")
        unrelated = {**self.mapping, "key": "other", "path": str(self.root / "other")}
        legacy = {k: v for k, v in self.mapping.items() if k != "config_file"}
        legacy.update(ssh_host="legacy-host", mcp_command="legacy mcp", bridge_command="legacy bridge")
        (self.dest / "projects.json").write_text(json.dumps({"projects": [legacy, unrelated]}))
        backup = migration.migrate(self.dest, "project", self.config_file, source, self.server.url)
        self.assertTrue((backup / "manifest.json").exists())
        with sqlite3.connect(target) as after:
            for name, rows in original.items():
                self.assertEqual(after.execute('SELECT * FROM "' + name + '"').fetchall(), rows)
        self.assertEqual(queue.read_bytes(), b"existing-hook-queue")
        mapping = json.loads((self.dest / "projects.json").read_text())
        self.assertEqual(mapping["projects"][0]["transport"], "http")
        self.assertNotIn("ssh_host", mapping["projects"][0])
        self.assertEqual(mapping["projects"][1], unrelated)
        self.assertEqual(self.config_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, "already exists"):
            migration.migrate(self.dest, "project", self.config_file, source, self.server.url)

    def test_wrong_team_snapshot_fails_before_switching_or_writing(self):
        source = self.root / "source.sqlite3"
        target = self.state / "runtime.sqlite3"
        with sqlite3.connect(target) as db, sqlite3.connect(source) as snapshot:
            db.backup(snapshot)
        target.unlink()
        before = (self.dest / "projects.json").read_bytes()
        config = {**self.config, "team_id": "different-team"}
        self.config_file.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, "different team"):
            migration.migrate(self.dest, "project", self.config_file, source, self.server.url)
        self.assertFalse(target.exists())
        self.assertEqual((self.dest / "projects.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
