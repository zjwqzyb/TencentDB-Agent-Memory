"""Routing, privacy and installer tests using temporary files only."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local"))
import client
import hook

spec = importlib.util.spec_from_file_location("adapter_install", ROOT / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "projects.json"
        p = patch.object(client, "CONFIG", self.config)
        p.start()
        self.addCleanup(p.stop)

    def item(self, key, path):
        return dict(
            key=key,
            path=str(path),
            enabled=True,
            name="test",
            team="team",
            agent="agent",
            ssh_host="memory-server",
            mcp_command="mcp " + key,
            bridge_command="bridge " + key,
        )

    def configure(self, items):
        self.config.write_text(json.dumps({"projects": items}))

    def test_deepest_resolved_project_and_no_prefix_collision(self):
        base = self.root / "repo"
        self.configure([self.item("parent", base), self.item("child", base / "child")])
        self.assertEqual(client.project(str(base / "child" / "src"))["key"], "child")
        self.assertIsNone(client.project(str(self.root / "repo-other")))
        self.assertIsNone(client.project("repo"))
        self.assertIsNone(client.project(None))

    def test_symlink_resolution(self):
        base = self.root / "repo"
        base.mkdir()
        link = self.root / "link"
        link.symlink_to(base, target_is_directory=True)
        self.configure([self.item("project", base)])
        self.assertEqual(client.project(str(link))["key"], "project")

    def test_invalid_keys_hosts_and_ambiguous_paths_fail_closed(self):
        first = self.item("valid", self.root)
        for field, value in [
            ("key", "../escape"),
            ("ssh_host", "-oProxyCommand=bad"),
            ("path", "relative"),
        ]:
            self.configure([{**first, field: value}])
            with self.subTest(field=field), self.assertRaises(ValueError):
                client.project(str(self.root))
        self.configure([first, {**first, "key": "other"}])
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            client.project(str(self.root))

    def test_missing_disabled_and_redaction(self):
        self.assertIsNone(client.project(str(self.root)))
        self.configure([{**self.item("project", self.root), "enabled": False}])
        self.assertIsNone(client.project(str(self.root)))
        for secret in (
            "sk-" + "x" * 24,
            "ghp_" + "x" * 24,
            "password=private-value",
            "user_key=private-value",
        ):
            self.assertNotIn(secret, client.redact(secret))


class HookCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = dict(
            key="test",
            name="测试",
            team="团队",
            agent="助手",
            capture_conversations=True,
        )
        self.event = dict(
            cwd="/test",
            session_id="session",
            turn_id="turn",
            prompt="password=secret",
            hook_event_name="UserPromptSubmit",
        )
        self.data = {
            "session": {"generation": 1, "state": "initialized"},
            "team": {"name": "团队", "team_id": "team"},
            "agent": {"name": "助手", "agent_id": "agent"},
            "task": None,
        }
        for name, value in [
            ("STATE", Path(self.temp.name)),
            ("project", lambda cwd: self.project),
        ]:
            p = patch.object(hook, name, value)
            p.start()
            self.addCleanup(p.stop)

    def begin(self):
        with patch.object(hook, "remote", return_value=self.data):
            return hook.main(self.event)

    def test_capture_disabled_still_recalls_without_pending_or_save(self):
        self.project["capture_conversations"] = False
        self.assertIn("未启用", str(self.begin()))
        with patch.object(hook, "remote") as remote:
            hook.main(
                {
                    **self.event,
                    "hook_event_name": "Stop",
                    "last_assistant_message": "done",
                }
            )
            remote.assert_not_called()
        with hook.connection(self.project) as db:
            self.assertEqual(
                db.execute("SELECT count(*) FROM pending").fetchone()[0], 0
            )

    def test_duplicate_stop_writes_once_and_redacts(self):
        self.begin()
        stop = {
            **self.event,
            "hook_event_name": "Stop",
            "last_assistant_message": "done",
        }
        with patch.object(hook, "remote", return_value={}) as remote:
            hook.main(stop)
            hook.main(stop)
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(
                remote.call_args.args[1]["messages"][0]["content"],
                "password=[REDACTED]",
            )
        with hook.connection(self.project) as db:
            self.assertEqual(
                db.execute("SELECT state,payload FROM outbox").fetchone(),
                ("sent", None),
            )

    def test_unknown_write_outcome_is_not_replayed_on_next_prompt(self):
        self.begin()
        with patch.object(hook, "remote", side_effect=TimeoutError):
            hook.main(
                {
                    **self.event,
                    "hook_event_name": "Stop",
                    "last_assistant_message": "done",
                }
            )
        with hook.connection(self.project) as db:
            self.assertEqual(
                db.execute("SELECT state FROM outbox").fetchone()[0], "review"
            )
        with patch.object(hook, "remote", return_value=self.data) as remote:
            hook.main({**self.event, "turn_id": "next"})
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(remote.call_args.args[1]["action"], "before")

    def test_failed_recall_does_not_guess_binding(self):
        with patch.object(hook, "remote", side_effect=RuntimeError("offline")):
            hook.main(self.event)
        with hook.connection(self.project) as db:
            self.assertEqual(
                db.execute("SELECT count(*) FROM pending").fetchone()[0], 0
            )

    def test_child_stop_requires_start_and_deduplicates(self):
        stop = {
            **self.event,
            "hook_event_name": "SubagentStop",
            "agent_id": "child",
            "last_assistant_message": "report",
        }
        with patch.object(hook, "remote") as remote:
            self.assertIn("未找到", str(hook.main(stop)))
            remote.assert_not_called()
        with patch.object(hook, "remote", return_value=self.data):
            hook.main({**stop, "hook_event_name": "SubagentStart"})
        with patch.object(hook, "remote", return_value={}) as remote:
            hook.main(stop)
            hook.main(stop)
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(remote.call_args.args[1]["agent_id"], "child")

    def test_rename_is_explicit_opt_in(self):
        self.assertNotIn("set_thread_title", str(self.begin()))


class InstallerTests(unittest.TestCase):
    def test_merge_idempotent_preserves_settings_and_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home, destination = root / "codex", root / "adapter"
            home.mkdir()
            original = (
                'model = "existing-model"\nmodel_provider = "existing-provider"\n'
            )
            (home / "config.toml").write_text(original)
            existing = {
                "hooks": {
                    "Stop": [{"hooks": [{"type": "command", "command": "other-hook"}]}]
                },
                "custom": True,
            }
            (home / "hooks.json").write_text(json.dumps(existing))
            backup = installer.install(home, destination, root)
            self.assertTrue((backup / "manifest.json").is_file())
            self.assertIn(original, (home / "config.toml").read_text())
            hooks = json.loads((home / "hooks.json").read_text())
            self.assertEqual(hooks["hooks"]["Stop"][0], existing["hooks"]["Stop"][0])
            self.assertTrue(hooks["custom"])
            (destination / "projects.json").write_text('{"projects": []}')
            self.assertIsNone(installer.install(home, destination, root))
            self.assertEqual(
                (destination / "projects.json").read_text(), '{"projects": []}'
            )

    def test_conflicting_mcp_preflight_does_not_modify_hooks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = '[mcp_servers.team_assets]\ncommand="another-command"\n'
            (root / "config.toml").write_text(config)
            with self.assertRaisesRegex(ValueError, "another command"):
                installer.install(root, root / "adapter")
            self.assertFalse((root / "hooks.json").exists())
            self.assertFalse((root / "adapter").exists())
