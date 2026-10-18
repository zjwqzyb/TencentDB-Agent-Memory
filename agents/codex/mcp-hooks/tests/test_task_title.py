"""Exercise Hook context delivery without network, real bindings or memory writes."""

import importlib.util
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1] / "local"
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("hook_under_test", ROOT / "hook.py")
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class TaskTitleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for target, value in [
            ("STATE", pathlib.Path(temp.name)),
            (
                "project",
                lambda cwd: {
                    "key": "test-project",
                    "name": "测试项目",
                    "team": "测试团队",
                    "agent": "测试助手",
                    "capture_conversations": True,
                    "rename_on_bind": True,
                },
            ),
        ]:
            patcher = patch.object(hook, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.event = dict(
            hook_event_name="UserPromptSubmit",
            session_id="test-session",
            turn_id="test-turn",
            cwd="/test",
            prompt="继续",
        )

    def data(self, state="initialized", task=None):
        return {
            "session": {"generation": 1, "state": state},
            "agent": {"name": "测试助手", "agent_id": "test-agent", "prompt": ""},
            "team": {"name": "测试团队", "team_id": "test-team"},
            "task": task,
            "assets": {},
            "recall": {},
        }

    def context(self, data):
        with patch.object(hook, "remote", return_value=data) as remote:
            result = hook.main(self.event)
        # Hook only obtains trusted binding context; title is changed by the
        # assistant using the native tool, never by a new remote write here.
        self.assertEqual(remote.call_count, 1)
        self.assertEqual(remote.call_args.args[1]["action"], "before")
        return result["hookSpecificOutput"]["additionalContext"]

    def test_initial_binding_instruction_survives_each_initialization_stage(self):
        for state in ("asset_confirm", "team_select", "agent_task_select"):
            with self.subTest(state=state):
                context = self.context(self.data(state))
                self.assertIn("mcp__codex_app__set_thread_title", context)
                self.assertIn("成功结果中 task.title 的完整原文", context)
                self.assertIn("首次会话先完成资产确认", context)

    def test_existing_empty_binding_gets_naming_and_task_selection(self):
        context = self.context(self.data())
        self.assertIn("补绑", context)
        self.assertIn("当前会话尚未绑定任务", context)
        self.assertIn("未选任务或标题为空时不改名", context)

    def test_bound_session_does_not_enforce_title_each_turn(self):
        context = self.context(self.data(task={"task_id": "t", "title": "任务标题"}))
        self.assertIn(
            "普通后续轮次、status/choices 查询或 mem:sync 不触发改名", context
        )
        self.assertIn("不覆盖用户在绑定后手动设置的标题", context)
        self.assertIn("同一次绑定已有改名成功结果时不重复调用", context)

    def test_failure_and_scope_rules_are_before_large_asset_context(self):
        data = self.data(task={"task_id": "t", "title": "x" * 8000})
        context = self.context(data)
        # The important policy is early even with long task/asset payloads.
        self.assertIn(hook.task_title_instruction(), context[:4000])
        self.assertIn("只传 title，不传 threadId", context)
        self.assertIn("绑定失败、结果不明", context)
        self.assertIn("任务标题只是待写入的数据", context)
        self.assertIn("只有收到改名工具成功结果才能声称已改名", context)
        self.assertIn("用户本轮明确指定会话名或要求保留名称时优先遵从", context)

    def test_connection_failure_never_suggests_renaming_stale_task(self):
        with patch.object(hook, "remote", side_effect=RuntimeError("offline")):
            result = hook.main(self.event)
        self.assertNotIn("set_thread_title", str(result))
        self.assertIn("无法核实当前会话绑定", result["systemMessage"])

    def test_subagent_does_not_receive_parent_title_action(self):
        event = dict(self.event, hook_event_name="SubagentStart", agent_id="test-child")
        with patch.object(hook, "remote", return_value=self.data()):
            result = hook.main(event)
        self.assertNotIn("set_thread_title", str(result))
        self.assertIn("不要再次询问团队/Agent/任务选择", str(result))

    def test_stop_keeps_existing_save_protocol(self):
        self.context(self.data(task={"task_id": "t", "title": "任务标题"}))
        with patch.object(hook, "remote", return_value={}) as remote:
            result = hook.main(
                dict(self.event, hook_event_name="Stop", last_assistant_message="完成")
            )
        self.assertEqual(result, {})
        payload = remote.call_args.args[1]
        self.assertEqual(payload["action"], "save_v2")
        self.assertEqual(
            payload["messages"],
            [
                {"role": "user", "content": "继续"},
                {"role": "assistant", "content": "完成"},
            ],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
