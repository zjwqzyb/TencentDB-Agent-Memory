"""Real subprocess disconnects: retry reads; never resend dispatched writes."""

import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local"))
from mcp_transport import Supervisor


class ReconnectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.supervisor = Supervisor(
            [
                sys.executable,
                str(Path(__file__).parent / "fake_upstream.py"),
                str(self.folder),
                "normal",
            ],
            lambda *a, **kw: None,
            startup_timeout=3,
            request_timeout=3,
            handshake_timeout=1,
            backoff=(0.01,),
        )
        self.addAsyncCleanup(self.supervisor.close_upstream, "test_complete")
        self.initialize = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2024-11-05"},
        }

    def call(self, name, mid=2):
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "method": "tools/call",
            "params": {"name": name, "arguments": {}},
        }

    async def test_disconnected_read_reconnects_and_retries(self):
        await self.supervisor.handle(self.initialize)
        result = await self.supervisor.handle(self.call("read"))
        self.assertFalse(result["result"].get("isError"))
        self.assertEqual(
            (self.folder / "calls").read_text().splitlines(), ["read", "read"]
        )

    async def test_dispatched_mutation_is_not_replayed_and_transport_recovers(self):
        await self.supervisor.handle(self.initialize)
        result = await self.supervisor.handle(self.call("mutate"))
        self.assertTrue(result["result"]["isError"])
        self.assertIn("Outcome unknown", result["result"]["content"][0]["text"])
        self.assertEqual((self.folder / "calls").read_text().splitlines(), ["mutate"])
        result = await self.supervisor.handle(self.call("read", 3))
        self.assertFalse(result["result"].get("isError"))
        self.assertEqual(
            (self.folder / "calls").read_text().splitlines(), ["mutate", "read"]
        )

    async def test_manifest_change_requires_restart(self):
        self.supervisor.command[-1] = "manifest-change"
        await self.supervisor.handle(self.initialize)
        result = await self.supervisor.handle(self.call("read"))
        self.assertTrue(result["result"]["isError"])
        self.assertIn("incompatible", result["result"]["content"][0]["text"])
        self.assertEqual((self.folder / "calls").read_text().splitlines(), ["read"])

    async def test_eof_drains_accepted_requests(self):
        reader = asyncio.StreamReader()
        reader.feed_data(
            (
                json.dumps(self.initialize)
                + "\n"
                + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"})
                + "\n"
            ).encode()
        )
        reader.feed_eof()
        replies = []
        await self.supervisor.serve(reader, replies.append)
        self.assertEqual([r["id"] for r in replies], [1, 2])

    def test_unannotated_or_mutable_tools_are_not_safe(self):
        self.supervisor.manifest = {
            "unknown": {},
            "mutable": {"annotations": {"idempotentHint": True}},
        }
        self.assertFalse(self.supervisor.replay_safe(self.call("unknown")))
        self.assertFalse(self.supervisor.replay_safe(self.call("mutable")))
        self.assertTrue(self.supervisor.replay_safe({"method": "ping"}))
