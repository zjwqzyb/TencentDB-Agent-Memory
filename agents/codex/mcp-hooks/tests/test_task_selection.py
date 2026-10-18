"""Isolated runtime regression tests. No network, production state, or memory writes."""

import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(ROOT))
stub = types.ModuleType("project_api")
stub.C = {"team_id": "team", "agent_id": "agent", "user_id": "user"}
stub.api = lambda *args: None
_previous = sys.modules.get("project_api")
sys.modules["project_api"] = stub
spec = importlib.util.spec_from_file_location(
    "runtime_under_test", ROOT / "project_runtime.py"
)
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)
if _previous is None:
    del sys.modules["project_api"]
else:
    sys.modules["project_api"] = _previous


class TaskSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        rt.DB = str(pathlib.Path(self.temp.name) / "runtime.sqlite3")
        self.tasks = []
        self.api_patch = patch.object(rt, "api", self.api)
        self.api_patch.start()
        self.addCleanup(self.api_patch.stop)

    def api(self, path, body):
        if path == "meta/team/get":
            return {"status": "active"}
        if path == "meta/team-member/get":
            return {"status": "active"}
        if path == "meta/agent/get":
            return {
                "team_id": "team",
                "owner_user_id": "user" if body["agent_id"] == "agent" else "other",
                "status": "active",
            }
        if path == "task/list-with-agents":
            start = body.get("offset", 0)
            return {
                "items": self.tasks[start : start + body["limit"]],
                "total": len(self.tasks),
            }
        if path == "meta/task/get":
            return {
                "task_id": body["task_id"],
                "team_id": "other" if body["task_id"] == "foreign" else "team",
            }
        if path == "meta/task-agent/list":
            return {
                "items": (
                    [] if body["task_id"] == "unlinked" else [{"agent_id": "agent"}]
                )
            }
        if path in ("knowledge/agent-fixed", "skill/list", "chat-memory/agent-fixed"):
            return {"items": []}
        raise AssertionError(path)

    def call(self, op, **kwargs):
        return rt.session(
            {
                "session_id": "isolated-test",
                "operation": op,
                "expected_generation": 1,
                **kwargs,
            }
        )

    def add_task(self):
        self.tasks.append({"task_id": "task", "agents": [{"agent_id": "agent"}]})

    def initialize(self):
        return self.call("initialize_defaults", confirmed=True)

    def select_stage(self):
        self.call("confirm_assets", confirmed=True)
        self.call("select_team", team_id="team")

    def test_defaults_without_tasks(self):
        self.assertIsNone(self.initialize()["task"])

    def test_defaults_with_tasks_stays_uninitialized(self):
        self.add_task()
        with self.assertRaisesRegex(ValueError, "Task selection required"):
            self.initialize()
        self.assertEqual(rt.state("isolated-test")["state"], "asset_confirm")

    def test_manual_initialization_cannot_skip_existing_task(self):
        self.add_task()
        self.select_stage()
        with self.assertRaisesRegex(ValueError, "Task selection required"):
            self.call("select_agent_task", agent_id="agent")
        self.assertEqual(rt.state("isolated-test")["state"], "agent_task_select")
        result = self.call("select_agent_task", agent_id="agent", task_id="task")
        self.assertEqual(result["session"]["generation"], 1)
        self.assertEqual(result["task"]["task_id"], "task")

    def test_complete_task_preserves_old_generation(self):
        self.initialize()
        self.add_task()
        result = self.call("select_agent_task", agent_id="agent", task_id="task")
        self.assertEqual(result["session"]["generation"], 2)
        self.assertEqual(rt.binding("isolated-test")["task_id"], "task")
        self.assertIsNone(rt.binding("isolated-test", 1)["task_id"])
        with rt.db() as conn:
            self.assertEqual(
                conn.execute("SELECT count(*) FROM bindings").fetchone()[0], 2
            )
            self.assertEqual(
                conn.execute(
                    "SELECT generation FROM transitions ORDER BY rowid DESC LIMIT 1"
                ).fetchone()[0],
                2,
            )

    def test_stale_generation_and_repeat_selection(self):
        self.initialize()
        self.call("select_agent_task", agent_id="agent", task_id="task")
        with self.assertRaisesRegex(ValueError, "generation changed"):
            self.call("select_agent_task", agent_id="agent", task_id="task")
        result = self.call(
            "select_agent_task", agent_id="agent", task_id="task", expected_generation=2
        )
        self.assertEqual(result["session"]["generation"], 2)

    def test_cannot_replace_task_or_agent(self):
        self.initialize()
        with self.assertRaisesRegex(ValueError, "Cannot change the Agent"):
            self.call("select_agent_task", agent_id="other", task_id="task")
        self.call("select_agent_task", agent_id="agent", task_id="task")
        with self.assertRaisesRegex(ValueError, "already selected"):
            self.call(
                "select_agent_task",
                agent_id="agent",
                task_id="other",
                expected_generation=2,
            )

    def test_invalid_task_is_rejected_without_state_change(self):
        self.initialize()
        for task in ("foreign", "unlinked"):
            with self.subTest(task=task), self.assertRaisesRegex(
                ValueError, "Task must belong"
            ):
                self.call("select_agent_task", agent_id="agent", task_id=task)
        self.assertEqual(rt.state("isolated-test")["generation"], 1)
        self.assertIsNone(rt.binding("isolated-test")["task_id"])

    def test_task_lookup_failure_is_not_no_tasks(self):
        original = self.api

        def failing(path, body):
            if path == "task/list-with-agents":
                raise RuntimeError("offline")
            return original(path, body)

        with patch.object(rt, "api", failing), self.assertRaisesRegex(
            RuntimeError, "offline"
        ):
            self.initialize()
        self.assertEqual(rt.state("isolated-test")["state"], "asset_confirm")

    def test_tasks_beyond_first_page(self):
        self.tasks = [{"agents": [{"agent_id": "other"}]} for _ in range(100)]
        self.add_task()
        with self.assertRaisesRegex(ValueError, "Task selection required"):
            self.initialize()

    def test_other_agents_tasks_do_not_block_empty_binding(self):
        self.tasks = [{"agents": [{"agent_id": "other"}]}]
        self.assertIsNone(self.initialize()["task"])

    def test_initialized_defaults_cannot_skip_new_tasks(self):
        self.initialize()
        self.add_task()
        with self.assertRaisesRegex(ValueError, "Task selection required"):
            self.initialize()

    def test_child_binding_remains_pinned_and_read_only(self):
        self.initialize()
        rt.register_child({"session_id": "isolated-test", "agent_id": "isolated-child"})
        self.call("select_agent_task", agent_id="agent", task_id="task")
        self.assertIsNone(rt.binding("isolated-child")["task_id"])
        with self.assertRaisesRegex(ValueError, "Subagent inherits"):
            rt.session(
                {
                    "session_id": "isolated-child",
                    "operation": "select_agent_task",
                    "expected_generation": 1,
                    "agent_id": "agent",
                    "task_id": "task",
                }
            )

    def test_concurrent_generation_change_prevents_overwrite(self):
        self.initialize()
        original = rt.validate

        def racing(binding):
            result = original(binding)
            with rt.db() as conn:
                conn.execute(
                    "UPDATE sessions SET generation=2,task_id='concurrent' WHERE sid='isolated-test'"
                )
            return result

        with patch.object(rt, "validate", racing), self.assertRaisesRegex(
            ValueError, "Concurrent session change"
        ):
            self.call("select_agent_task", agent_id="agent", task_id="task")
        self.assertEqual(rt.state("isolated-test")["task_id"], "concurrent")
        with rt.db() as conn:
            self.assertEqual(
                conn.execute("SELECT count(*) FROM bindings").fetchone()[0], 1
            )

    def test_other_team_is_rejected_before_api_call(self):
        with patch.object(rt, "api") as api, self.assertRaisesRegex(
            ValueError, "outside this configured project"
        ):
            rt.member("another-team")
        api.assert_not_called()

    def test_once_success_is_deduplicated_and_different_payload_rejected(self):
        calls = []

        def mutation():
            calls.append("called")
            return {"saved": True}

        self.assertTrue(rt.once("write-id", {"value": 1}, mutation)["saved"])
        self.assertTrue(rt.once("write-id", {"value": 1}, mutation)["deduplicated"])
        with self.assertRaisesRegex(ValueError, "different content"):
            rt.once("write-id", {"value": 2}, mutation)
        self.assertEqual(calls, ["called"])

    def test_uncertain_once_never_repeats_mutation(self):
        def failing():
            raise TimeoutError("response lost")

        with self.assertRaises(TimeoutError):
            rt.once("write-id", {"value": 1}, failing)
        with patch.object(rt, "api") as api, self.assertRaisesRegex(
            RuntimeError, "uncertain"
        ):
            rt.once("write-id", {"value": 1}, api)
        api.assert_not_called()

    def test_archive_failure_does_not_repeat_successful_memory_import(self):
        self.initialize()
        calls = []
        original = self.api

        def api(path, body):
            if path == "chat-memory/import":
                calls.append(path)
                return {"accepted_count": len(body["messages"])}
            if path == "skill/conversation/add":
                raise TimeoutError("archive response lost")
            return original(path, body)

        request = {
            "session_id": "isolated-test",
            "generation": 1,
            "request_id": "save-id",
            "messages": [{"role": "user", "content": "hello"}],
        }
        with patch.object(rt, "api", api):
            with self.assertRaises(TimeoutError):
                rt.save(request)
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                rt.save(request)
        self.assertEqual(calls, ["chat-memory/import"])

    def test_nested_child_keeps_snapshot_after_root_rebinds(self):
        self.initialize()
        rt.register_child({"session_id": "isolated-test", "agent_id": "child"})
        self.call("select_agent_task", agent_id="agent", task_id="task")
        rt.register_child({"session_id": "child", "agent_id": "grandchild"})
        with patch.object(rt, "save", return_value={"saved": True}) as save:
            rt.save_child(
                {
                    "session_id": "child",
                    "agent_id": "grandchild",
                    "request_id": "child-report",
                    "turn_id": "turn",
                    "final": "result",
                }
            )
        payload = save.call_args.args[0]
        self.assertEqual(payload["session_id"], "grandchild")
        self.assertEqual(payload["generation"], 1)
        self.assertIsNone(rt.binding("grandchild")["task_id"])

    def test_child_cannot_use_generic_capture_or_skill_mutations(self):
        self.initialize()
        rt.register_child({"session_id": "isolated-test", "agent_id": "child"})
        with self.assertRaisesRegex(ValueError, "parent callback"):
            rt.run({"action": "save_v2", "session_id": "child"})
        with self.assertRaisesRegex(ValueError, "read-only"):
            rt.run({"action": "create_skill", "session_id": "child"})

    def test_managed_tasks_require_revision_aware_api(self):
        self.initialize()
        self.call("select_agent_task", agent_id="agent", task_id="task")
        original = self.api

        def api(path, body):
            if path == "meta/task/get":
                return {
                    "task_id": "task",
                    "team_id": "team",
                    "metadata_json": '{"issue": {}}',
                }
            return original(path, body)

        with patch.object(rt, "api", api), self.assertRaisesRegex(
            ValueError, "expected_revision"
        ):
            rt.run(
                {
                    "action": "task",
                    "operation": "update",
                    "session_id": "isolated-test",
                    "request_id": "task-update",
                    "title": "new title",
                }
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
