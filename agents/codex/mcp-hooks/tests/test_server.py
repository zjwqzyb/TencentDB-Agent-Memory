"""Server entry points and Docker argument isolation without live services."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ServerSmokeTests(unittest.TestCase):
    def test_stdio_manifest_and_uninitialized_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = json.loads((ROOT / "examples/project.server.json").read_text())
            (root / "example-project.json").write_text(json.dumps(config))
            requests = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "get_project_agent",
                        "arguments": {"session_id": "test-session"},
                    },
                },
            ]
            env = {
                **os.environ,
                "TENCENT_MEMORY_CONFIG_DIR": str(root),
                "TENCENT_MEMORY_STATE_DIR": str(root),
            }
            result = subprocess.run(
                [sys.executable, str(ROOT / "server/server.py"), "example-project"],
                input="\n".join(json.dumps(r) for r in requests) + "\n",
                text=True,
                capture_output=True,
                env=env,
                check=True,
            )
            replies = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(replies[0]["result"]["serverInfo"]["version"], "3.2.0")
            tools = replies[1]["result"]["tools"]
            self.assertEqual(len(tools), 14)
            task_tool = next(t for t in tools if t["name"] == "manage_project_task")
            props = task_tool["inputSchema"]["properties"]
            self.assertEqual(
                props["operation"]["enum"],
                ["list", "get", "create", "update", "comment"],
            )
            self.assertIn("expected_revision", props)
            self.assertIn("acceptance", props["issue"]["properties"])
            for tool in tools:
                self.assertIn("session_id", tool["inputSchema"]["required"])
            self.assertTrue(replies[2]["result"]["isError"])
            self.assertIn("not initialized", replies[2]["result"]["content"][0]["text"])
            self.assertEqual(result.stderr, "")

    def test_missing_project_and_traversal_fail_closed(self):
        for args in ([], ["../escape"]):
            result = subprocess.run(
                [sys.executable, str(ROOT / "server/server.py"), *args],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_container_receives_only_selected_config_and_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "state/example-project").mkdir(parents=True)
            (root / "config/example-project.json").write_text("{}")
            docker = root / "docker"
            docker.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            docker.chmod(0o700)
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "TENCENT_MEMORY_ROOT": str(root),
            }
            wrapper = ROOT / "server/tencent-memory-mcp-remote"
            result = subprocess.run(
                [str(wrapper), "example-project"],
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
            args = result.stdout.splitlines()
            self.assertIn(
                str(root / "config/example-project.json")
                + ":/config/example-project.json:ro",
                args,
            )
            self.assertIn(str(root / "state/example-project") + ":/state", args)
            self.assertIn("--read-only", args)
            self.assertIn("10001:10001", args)
            for invalid in ("../escape", "other", "-bad"):
                result = subprocess.run(
                    [str(wrapper), invalid], env=env, text=True, capture_output=True
                )
                self.assertNotEqual(result.returncode, 0)
