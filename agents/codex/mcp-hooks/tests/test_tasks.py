"""Task CLI parity, CAS conflicts, team boundaries and durable retry semantics."""

import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "local"))
import project_tasks as tasks
from task_commands import COMMANDS, instruction
from test_task_selection import rt


class TaskOperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        p = patch.object(rt, "DB", str(Path(self.temp.name) / "runtime.sqlite3"))
        p.start()
        self.addCleanup(p.stop)
        self.binding = {
            "team_id": "team",
            "agent_id": "agent",
            "task_id": "task-existing",
        }
        self.item = {
            "task_id": "task-existing",
            "team_id": "team",
            "title": "existing",
            "description": "keep description",
            "issue": {
                "revision": 1,
                "stage": "todo",
                "acceptance": [{"text": "keep criterion", "done": False}],
                "labels": ["keep"],
            },
        }
        self.calls = []
        self.failure = None
        self.mutations = 0

    def api(self, path, body):
        self.calls.append((path, copy.deepcopy(body)))
        if path == "meta/issue/get":
            return copy.deepcopy({**self.item, "task_id": body["task_id"]})
        if path == "meta/issue/list":
            index = body["offset"]
            items = [{**self.item, "task_id": "task-" + str(i)} for i in range(3)]
            return {"items": items[index : index + body["limit"]], "total": 3}
        if self.failure:
            raise self.failure
        self.mutations += 1
        if path == "meta/issue/create":
            return {
                "task_id": "task-new",
                **body,
                "issue": {"revision": 1, **body["issue"]},
            }
        self.assertEqual(body["expected_revision"], self.item["issue"]["revision"])
        if path == "meta/issue/update":
            self.item.update(
                {key: body[key] for key in ("title", "description") if key in body}
            )
            self.item["issue"].update(body["issue"])
        elif path == "meta/issue/comment":
            self.item.setdefault("comments", []).append(body["body"])
        else:
            self.fail("Unexpected/legacy route: " + path)
        self.item["issue"]["revision"] += 1
        return copy.deepcopy(self.item)

    def call(self, operation, **kwargs):
        return tasks.execute(
            {"operation": operation, "request_id": "request-1", **kwargs},
            self.binding,
            self.api,
            rt.once,
        )

    def test_update_managed_task_uses_native_revision_patch(self):
        result = self.call(
            "update",
            expected_revision=1,
            description="new description",
            issue={"stage": "in_progress"},
        )
        self.assertEqual(result["issue"]["revision"], 2)
        self.assertEqual(
            self.calls[-1],
            (
                "meta/issue/update",
                {
                    "task_id": "task-existing",
                    "expected_revision": 1,
                    "description": "new description",
                    "issue": {"stage": "in_progress"},
                },
            ),
        )
        self.assertEqual(result["issue"]["labels"], ["keep"])
        self.assertEqual(
            result["issue"]["acceptance"], self.item["issue"]["acceptance"]
        )

    def test_successful_update_retry_returns_cached_result_after_revision_advanced(
        self,
    ):
        self.call("update", expected_revision=1, title="new title")
        calls = len(self.calls)
        result = self.call("update", expected_revision=1, title="new title")
        self.assertTrue(result["deduplicated"])
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(self.mutations, 1)

    def test_changed_retry_body_is_rejected(self):
        self.call("update", expected_revision=1, title="new title")
        with self.assertRaisesRegex(ValueError, "different content"):
            self.call("update", expected_revision=2, title="another title")
        self.assertEqual(self.mutations, 1)

    def test_revision_zero_legacy_task_is_upgraded_via_issue_api(self):
        self.item["issue"]["revision"] = 0
        result = self.call("update", expected_revision=0, title="updated legacy task")
        self.assertEqual(result["issue"]["revision"], 1)
        self.assertEqual(self.calls[-1][0], "meta/issue/update")

    def test_stale_revision_has_no_write_or_automatic_retry(self):
        with self.assertRaisesRegex(ValueError, "revision conflict"):
            self.call("update", expected_revision=0, title="stale")
        self.assertEqual(self.mutations, 0)
        with rt.db() as db:
            self.assertEqual(
                db.execute("SELECT status FROM writes").fetchone()[0], "rejected"
            )
        calls = len(self.calls)
        with self.assertRaisesRegex(ValueError, "Previous mutation rejected"):
            self.call("update", expected_revision=0, title="stale")
        self.assertEqual(len(self.calls), calls)

    def test_missing_revision_request_id_and_empty_patch_do_not_write(self):
        for changes in (
            {"title": "x"},
            {"expected_revision": True, "title": "x"},
            {"expected_revision": 1},
            {"expected_revision": 1, "title": "x", "request_id": ""},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.call("update", **changes)
        self.assertEqual(self.calls, [])

    def test_comment_appends_and_keeps_description(self):
        result = self.call("comment", expected_revision=1, body="verified progress")
        self.assertEqual(
            self.calls[-1],
            (
                "meta/issue/comment",
                {
                    "task_id": "task-existing",
                    "expected_revision": 1,
                    "body": "verified progress",
                },
            ),
        )
        self.assertEqual(result["description"], "keep description")
        self.assertEqual(result["comments"], ["verified progress"])
        self.assertTrue(
            self.call("comment", expected_revision=1, body="verified progress")[
                "deduplicated"
            ]
        )
        self.assertEqual(self.mutations, 1)

    def test_get_explicit_task_or_default_bound_task_and_no_numeric_issue_number(self):
        self.assertEqual(self.call("get")["task_id"], "task-existing")
        self.assertEqual(
            self.call("get", task_id="task-other")["task_id"], "task-other"
        )
        for value in ("42", "#42"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.call("get", task_id=value)

    def test_explicit_task_does_not_change_session_binding(self):
        result = self.call(
            "update", task_id="task-other", expected_revision=1, title="other"
        )
        self.assertEqual(self.calls[-1][1]["task_id"], "task-other")
        self.assertEqual(self.binding["task_id"], "task-existing")

    def test_foreign_team_blocks_detail_and_mutation(self):
        self.item["team_id"] = "foreign"
        for op in ("get", "update", "comment"):
            with self.subTest(op=op), self.assertRaisesRegex(
                ValueError, "outside this session team"
            ):
                self.call(
                    op, expected_revision=1, title="x", body="x", request_id="id-" + op
                )
        self.assertEqual(self.mutations, 0)

    def test_create_subtask_uses_native_relationships_and_links_current_agent(self):
        result = self.call(
            "create",
            title="subtask",
            issue={
                "parent_id": "task-parent",
                "blocked_by": ["task-blocker"],
                "triage": "ready-for-agent",
            },
        )
        payload = self.calls[-1][1]
        self.assertEqual(self.calls[-1][0], "meta/issue/create")
        self.assertEqual(payload["team_id"], "team")
        self.assertEqual(payload["linked_agents"], [{"agent_id": "agent"}])
        self.assertEqual(result["issue"]["parent_id"], "task-parent")
        self.assertNotIn("creator_user_id", payload)
        self.assertEqual(self.binding["task_id"], "task-existing")

    def test_status_alias_does_not_bypass_completion_rules(self):
        self.failure = RuntimeError("server rejected missing verification evidence")
        with self.assertRaisesRegex(RuntimeError, "verification evidence"):
            self.call("update", expected_revision=1, status="completed")
        self.assertEqual(self.calls[-1][1]["issue"], {"stage": "done"})
        with self.assertRaisesRegex(ValueError, "conflicting status"):
            self.call(
                "update", expected_revision=1, status="running", issue={"stage": "done"}
            )

    def test_workflow_patch_fields_are_preserved_without_filling_defaults(self):
        fields = {
            "parent_id": None,
            "assignee_agent_id": "agent",
            "blocked_by": ["task-blocker"],
            "labels": ["new"],
            "acceptance": [{"text": "verified", "done": True}],
            "evidence": "actual test output",
            "milestone": "release",
            "kind": "bug",
            "triage": "needs-info",
        }
        self.call("update", expected_revision=1, issue=fields)
        self.assertEqual(self.calls[-1][1]["issue"], fields)
        self.assertNotIn("stage", self.calls[-1][1]["issue"])
        for forbidden in ("revision", "comments", "team_id"):
            with self.subTest(forbidden=forbidden), self.assertRaisesRegex(
                ValueError, "editable"
            ):
                self.call("update", expected_revision=1, issue={forbidden: "forged"})

    def test_list_cli_filters_and_all_pages(self):
        result = self.call(
            "list",
            ready=True,
            all=True,
            limit=2,
            query="query",
            state="open",
            stage="todo",
            triage="ready-for-agent",
            label="backend",
            parent_id="task-parent",
        )
        self.assertEqual(len(result["items"]), 3)
        payload = self.calls[0][1]
        self.assertEqual(
            payload,
            {
                "team_id": "team",
                "limit": 2,
                "offset": 0,
                "query": "query",
                "state": "open",
                "stage": "todo",
                "triage": "ready-for-agent",
                "label": "backend",
                "parent_id": "task-parent",
                "ready": True,
            },
        )
        self.assertEqual(self.calls[1][1]["offset"], 2)

    def test_list_does_not_silently_accept_incomplete_pagination(self):
        def api(path, body):
            return {"items": [], "total": 10}

        with self.assertRaisesRegex(ValueError, "Incomplete"):
            tasks.execute(
                {"operation": "list", "all": True}, self.binding, api, rt.once
            )

    def test_unknown_outcome_keeps_ledger_uncertain_and_does_not_resend(self):
        self.failure = TimeoutError("response lost")
        with self.assertRaises(TimeoutError):
            self.call("update", expected_revision=1, title="x")
        count = len(self.calls)
        with self.assertRaisesRegex(RuntimeError, "uncertain"):
            self.call("update", expected_revision=1, title="x")
        self.assertEqual(len(self.calls), count)

    def test_child_may_get_but_cannot_comment_or_update(self):
        with patch.object(rt, "binding", return_value=self.binding), patch.object(
            rt, "child_binding", return_value={"parent": "parent"}
        ), patch.object(rt, "api", self.api):
            self.assertEqual(
                rt.run({"action": "task", "operation": "get", "session_id": "child"})[
                    "task_id"
                ],
                "task-existing",
            )
            for op in ("comment", "create", "update"):
                with self.subTest(op=op), self.assertRaisesRegex(
                    ValueError, "read-only"
                ):
                    rt.run({"action": "task", "operation": op, "session_id": "child"})


class CommandTests(unittest.TestCase):
    def test_catalog_covers_cli_actions_and_new_workflows(self):
        actions = {action for _, action, _ in COMMANDS}
        self.assertEqual(actions, {"list", "get", "create", "update", "comment"})
        text = instruction()
        for command, _, _ in COMMANDS:
            self.assertIn(command, text)
        for required in (
            "expected_revision",
            "revision=0",
            "request_id",
            "不自动",
            "parent_id",
            "blocked_by",
            "evidence",
        ):
            self.assertIn(required, text)


class PanelErrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / "example-project.json").write_text(
            (ROOT / "examples/project.server.json").read_text()
        )
        with patch.dict(
            os.environ,
            {
                "TENCENT_MEMORY_PROJECT": "example-project",
                "TENCENT_MEMORY_CONFIG_DIR": str(root),
            },
        ):
            spec = importlib.util.spec_from_file_location(
                "task_api_under_test", ROOT / "server/project_api.py"
            )
            self.api = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.api)

    def test_http_revision_conflict_is_definite_rejection_and_safe(self):
        error = HTTPError(
            "http://local/api",
            409,
            "Conflict",
            {},
            io.BytesIO(b"secret body must not escape"),
        )
        with patch.object(
            self.api.urllib.request, "urlopen", side_effect=error
        ), self.assertRaises(self.api.PanelError) as raised:
            self.api.api("meta/issue/update", {})
        self.assertTrue(raised.exception.definite_rejection)
        self.assertIn("revision conflict", str(raised.exception))
        self.assertNotIn("secret", str(raised.exception))

    def test_5xx_remains_uncertain_and_envelope_conflict_is_classified(self):
        self.assertFalse(self.api.PanelError(500).definite_rejection)
        with patch.object(self.api.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value = io.StringIO('{"code":409}')
            with self.assertRaises(self.api.PanelError) as raised:
                self.api.api("meta/issue/update", {})
        self.assertTrue(raised.exception.definite_rejection)

    def test_conflict_after_preflight_is_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            rt, "DB", str(Path(directory) / "state.sqlite3")
        ):

            def rejected():
                raise self.api.PanelError(409)

            with self.assertRaises(self.api.PanelError):
                rt.once("request", {"patch": 1}, rejected)
            with self.assertRaisesRegex(ValueError, "Previous mutation rejected"):
                rt.once("request", {"patch": 1}, lambda: self.fail("must not replay"))
            with rt.db() as db:
                self.assertEqual(
                    db.execute("SELECT status FROM writes").fetchone()[0], "rejected"
                )
