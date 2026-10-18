"""Keep local MCP stdio alive when the remote SSH transport disconnects.

Only initialization and positively identified read-only, idempotent calls may
be retried. A transmitted write is never replayed, including on a timeout.
Logs contain lifecycle metadata only, never payloads or remote stderr text.
"""

import asyncio
import contextlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import time


class TransportError(Exception):
    pass


class RecoveryError(TransportError):
    pass


def lifecycle_logger():
    from client import STATE

    folder = STATE / "mcp"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = folder / ("lifecycle-%s.jsonl" % os.getpid())
    # Separate files avoid cross-process rotation races. Keep recent runs only.
    for old in sorted(
        folder.glob("lifecycle-*.jsonl*"), key=lambda p: p.stat().st_mtime
    )[:-40]:
        with contextlib.suppress(OSError):
            if time.time() - old.stat().st_mtime > 7 * 86400:
                old.unlink()
    fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    os.close(fd)
    logger = logging.getLogger("team-assets-%s" % os.getpid())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = RotatingFileHandler(path, maxBytes=1024 * 1024, backupCount=2)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)

    def emit(event, **fields):
        logger.info(
            json.dumps(
                dict(
                    time=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    event=event,
                    launcher_pid=os.getpid(),
                    **fields,
                )
            )
        )

    return emit


class Supervisor:
    def __init__(
        self,
        command,
        emit,
        startup_timeout=45,
        request_timeout=55,
        handshake_timeout=12,
        backoff=(0.5, 1, 2, 4),
    ):
        self.command, self.emit = command, emit
        self.startup_timeout, self.request_timeout = startup_timeout, request_timeout
        self.handshake_timeout, self.backoff = handshake_timeout, backoff
        self.proc = None
        self.stderr_task = None
        self.init_params = None
        self.init_result = None
        self.manifest = None
        self.upstream_ready = False
        self.serial = 0

    async def stderr_reader(self, proc):
        categories = set()
        # Drain bounded chunks, avoiding both pipe backpressure and secret logs.
        while chunk := await proc.stderr.read(4096):
            text = chunk.decode(errors="replace").lower()
            for needle, category in [
                ("timed out", "connection_timeout"),
                ("connection reset", "connection_reset"),
                ("broken pipe", "broken_pipe"),
                ("permission denied", "authentication_failed"),
                ("traceback", "remote_exception"),
                ("out of memory", "out_of_memory"),
            ]:
                if needle in text:
                    categories.add(category)
        return sorted(categories)

    async def close_upstream(self, reason):
        proc, self.proc = self.proc, None
        self.upstream_ready = False
        if proc is None:
            return
        if proc.stdin:
            proc.stdin.close()
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
        categories = []
        if self.stderr_task:
            try:
                categories = await asyncio.wait_for(self.stderr_task, 1)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self.stderr_task.cancel()
            self.stderr_task = None
        self.emit(
            "upstream_closed",
            upstream_pid=proc.pid,
            exit_code=proc.returncode,
            reason=reason,
            stderr_categories=categories,
        )

    async def exchange(self, message):
        """One wire request; caller must decide whether replay is safe."""
        if not self.proc or self.proc.returncode is not None:
            raise TransportError("upstream_exited")
        try:
            self.proc.stdin.write(
                (json.dumps(message, ensure_ascii=False) + "\n").encode()
            )
            await self.proc.stdin.drain()
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    # Wait briefly for SSH to publish its actual exit status.
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(self.proc.wait(), 0.2)
                    raise TransportError("upstream_eof")
                try:
                    reply = json.loads(line)
                except (ValueError, UnicodeDecodeError) as exc:
                    raise TransportError("invalid_upstream_json") from exc
                if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0":
                    raise TransportError("invalid_upstream_message")
                if "id" not in reply and "method" in reply:
                    # This server does not currently emit notifications; ignore
                    # them during internal handshakes instead of polluting stdout.
                    continue
                if reply.get("id") != message["id"]:
                    raise TransportError("unexpected_upstream_response")
                if "result" not in reply and "error" not in reply:
                    raise TransportError("missing_upstream_result")
                return reply
        except (BrokenPipeError, ConnectionError, OSError, ValueError) as exc:
            raise TransportError("upstream_io_error") from exc

    async def connect_once(self):
        await self.close_upstream("replace_connection")
        self.proc = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )
        self.stderr_task = asyncio.create_task(self.stderr_reader(self.proc))
        self.emit("upstream_started", upstream_pid=self.proc.pid)
        self.serial += 1
        reply = await self.exchange(
            {
                "jsonrpc": "2.0",
                "id": "bridge-init-%s" % self.serial,
                "method": "initialize",
                "params": self.init_params,
            }
        )
        if "error" in reply:
            raise RecoveryError("upstream_rejected_initialization")
        result = reply["result"]
        if not isinstance(result, dict) or "protocolVersion" not in result:
            raise RecoveryError("invalid_initialization_result")
        if self.init_result is not None and any(
            result.get(k) != self.init_result.get(k)
            for k in ("protocolVersion", "capabilities")
        ):
            raise RecoveryError("upstream_protocol_changed")
        self.proc.stdin.write(
            b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
        )
        await self.proc.stdin.drain()
        tools = await self.exchange(
            {
                "jsonrpc": "2.0",
                "id": "bridge-tools-%s" % self.serial,
                "method": "tools/list",
                "params": {},
            }
        )
        if "error" in tools or not isinstance(
            tools.get("result", {}).get("tools"), list
        ):
            raise RecoveryError("invalid_tools_manifest")
        items = tools["result"]["tools"]
        if any(
            not isinstance(t, dict) or not isinstance(t.get("name"), str) for t in items
        ):
            raise RecoveryError("invalid_tools_manifest")
        manifest = {t["name"]: t for t in items}
        if len(manifest) != len(items):
            raise RecoveryError("duplicate_upstream_tools")
        if self.manifest is not None and manifest != self.manifest:
            raise RecoveryError("upstream_tools_changed_restart_required")
        self.init_result, self.manifest = result, manifest
        self.upstream_ready = True
        self.emit(
            "upstream_ready", upstream_pid=self.proc.pid, tool_count=len(manifest)
        )

    async def ensure_connected(self, deadline):
        if self.upstream_ready and self.proc and self.proc.returncode is None:
            return
        attempt = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TransportError("reconnect_deadline_exceeded")
            try:
                await asyncio.wait_for(
                    self.connect_once(), min(remaining, self.handshake_timeout)
                )
                return
            except RecoveryError:
                await self.close_upstream("recovery_incompatible")
                raise
            except (TransportError, OSError, asyncio.TimeoutError) as exc:
                reason = (
                    "handshake_timeout"
                    if isinstance(exc, asyncio.TimeoutError)
                    else (
                        str(exc) if isinstance(exc, TransportError) else "spawn_failed"
                    )
                )
                await self.close_upstream(reason)
                self.emit("reconnect_wait", attempt=attempt + 1, reason=reason)
                await asyncio.sleep(
                    max(
                        0,
                        min(
                            self.backoff[min(attempt, len(self.backoff) - 1)],
                            deadline - time.monotonic(),
                        ),
                    )
                )
                attempt += 1

    def replay_safe(self, request):
        if request.get("method") in ("ping", "tools/list"):
            return True
        if request.get("method") == "tools/call":
            annotations = (
                (self.manifest or {})
                .get(request.get("params", {}).get("name"), {})
                .get("annotations", {})
            )
            return (
                annotations.get("readOnlyHint") is True
                and annotations.get("idempotentHint") is True
            )
        return False

    @staticmethod
    def error(request, message):
        if request.get("method") == "tools/call":
            return {
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "content": [{"type": "text", "text": message}],
                    "isError": True,
                },
            }
        return {
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": -32001, "message": message},
        }

    async def handle(self, request):
        if "id" not in request:
            # Initialized is sent on every fresh upstream. Cancellation does not
            # replay calls; other notifications are not supported by this adapter.
            return None
        initializing = request.get("method") == "initialize"
        if initializing:
            self.init_params = request.get("params", {})
        elif self.init_result is None:
            return self.error(request, "MCP must be initialized first.")
        deadline = time.monotonic() + (
            self.startup_timeout if initializing else self.request_timeout
        )
        transmitted = False
        safe = False
        try:
            await self.ensure_connected(deadline)
            if initializing:
                return {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": self.init_result,
                }
            safe = self.replay_safe(request)
            for attempt in range(2):
                try:
                    # Set before any bytes are sent: partial writes are uncertain.
                    transmitted = True
                    return await asyncio.wait_for(
                        self.exchange(request), max(0.001, deadline - time.monotonic())
                    )
                except (TransportError, asyncio.TimeoutError) as exc:
                    reason = (
                        "request_timeout"
                        if isinstance(exc, asyncio.TimeoutError)
                        else str(exc)
                    )
                    await self.close_upstream(reason)
                    if not safe or attempt == 1 or time.monotonic() >= deadline:
                        raise TransportError(reason) from exc
                    self.emit("readonly_retry", reason=reason)
                    await self.ensure_connected(deadline)
        except (TransportError, OSError, asyncio.TimeoutError) as exc:
            self.emit(
                "request_failed",
                reason=str(exc) if isinstance(exc, TransportError) else "io_or_timeout",
                transmitted=transmitted,
                retry_safe=safe,
            )
            if transmitted and not safe:
                return self.error(
                    request,
                    "Remote MCP disconnected after dispatch. Outcome unknown; "
                    "the operation was NOT retried. Check server state before any retry; "
                    "reuse the original request_id for idempotent writes.",
                )
            if isinstance(exc, RecoveryError):
                return self.error(
                    request,
                    "Remote MCP contract is incompatible (" + str(exc) + "). "
                    "Restart team_assets to negotiate a fresh session. No write was replayed.",
                )
            return self.error(
                request,
                "Remote MCP unavailable. Local transport remains open; "
                "retry after connectivity returns. No write was replayed.",
            )

    async def serve(self, reader, send):
        self.emit("launcher_started")
        queue = asyncio.Queue(maxsize=64)

        async def ingest():
            while line := await reader.readline():
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                        raise ValueError()
                except (ValueError, UnicodeDecodeError):
                    send(
                        {
                            "jsonrpc": "2.0",
                            "id": None,
                            "error": {"code": -32700, "message": "Parse error"},
                        }
                    )
                    continue
                await queue.put(request)
            await queue.put(None)

        async def work():
            while True:
                request = await queue.get()
                if request is None:
                    return
                response = await self.handle(request)
                if response is not None:
                    send(response)

        tasks = [asyncio.create_task(ingest()), asyncio.create_task(work())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if tasks[0] in done:
                await tasks[1]
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.close_upstream("client_shutdown")
            self.emit("launcher_stopped")


async def stdio_main(command):
    import sys

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=32 * 1024 * 1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    supervisor = Supervisor(command, lifecycle_logger())
    main_task = asyncio.current_task()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, main_task.cancel)

    def send(response):
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    try:
        await supervisor.serve(reader, send)
    finally:
        transport.close()


def main(command):
    try:
        asyncio.run(stdio_main(command))
    except (asyncio.CancelledError, KeyboardInterrupt, BrokenPipeError):
        pass
