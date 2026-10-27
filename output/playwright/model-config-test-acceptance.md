# Model configuration connection-test acceptance

Date: 2026-10-26
Ticket: `task-sgus3hqpxx` — Memhub 模型配置：测试未保存配置的基础、JSON 与工具能力
Branch: `feat/server_team` (changes are in the working tree, not committed — the same
Core files also carry unrelated in-progress edits, so staging them wholesale would mix
another line of work into this ticket)

## What was built

### Server (Panel)
- `POST /api/v1/meta/instance-upstream/extraction/test`, NDJSON event stream:
  `started` (test_id / fingerprint / source / instance_id) → one `result` per capability
  (`basic`, `json`, `tools`, each with `status`, `duration_ms`, optional sanitized `error`)
  → `done`.
- `system_admin` only (single `auth/verify` call also yields the caller id used as the
  concurrency key); the instance identity comes from the already validated Panel headers,
  so a caller cannot pick another instance.
- Read-only: no store writes, no enable, no knowledge rebuild. Verified by asserting the
  only kernel action invoked is `auth/verify`.
- Single-flight per `instance + admin`: a second concurrent run returns
  `409 TEST_ALREADY_RUNNING`; a stale `base_version` returns `409 CONFIG_VERSION_CONFLICT`
  with `{expected, actual}`.
- Cancellation: the browser abort closes the panel request, `@hono/node-server` aborts
  `c.req.raw.signal`, and the probe's `fetch` is aborted — the fixture observes the
  upstream connection close.
- Endpoint safety: `https` only; `http` only for loopback and only with
  `PANEL_MODEL_TEST_ALLOW_LOOPBACK=true`; URL userinfo/query/fragment rejected;
  `redirect: "manual"` so cross-origin redirects are never followed; upstream response
  body capped at 128 KiB; error messages stripped of API keys / Bearer tokens and truncated.

### Server (Core)
- `POST /v3/internal/meta/instance-upstream/extraction/resolve` (Bearer-only, no
  `user_key`, not registered in the public `V3_SCHEMAS`): returns the plaintext `active`
  and `draft` endpoint fields so the Panel can reuse a stored Key when the form leaves it
  blank. `listInstanceUpstreamGroupsInternal` still strips `draft_json`.

### UI
- "连接能力测试" section in 设置 → 模型配置: test / cancel buttons, three capability rows
  with status tag, duration, error code + message, plus the `test_id` and an abbreviated
  config fingerprint; results reset when the form changes; the section is
  `aria-live="polite"`; narrow (390px) and dark layouts do not overflow.

## Passed

- `MemoryCore`: `npx vitest run src/metadata/service/instance-upstream-extraction.test.ts`
  → 12/12 tests passed (5 new resolve tests, incl. draft-only plaintext, active plaintext
  while the public `get` stays masked, and no-row defaults).
- `MemoryCore`: `npm run build:plugin` → build complete (8 files).
- `MemoryPanel`: `npx vitest run` → 9 files / 194 tests passed, including
  - `tests/model-config-probe.test.ts` — 30 tests: endpoint normalization/rejection,
    message sanitization, three capabilities against a deterministic OpenAI-compatible
    fixture (asserting endpoint path, Authorization presence, model, messages, tool
    schema and the `tool_call_id` continuation), auth/model-not-found/rate-limit/timeout/
    redirect/oversized-body/tool-unsupported/json-invalid classification, real upstream
    abort on cancel, fingerprint stability, run dedupe.
  - `tests/model-config-test-route.test.ts` — 10 tests: 403 non-admin before any endpoint
    resolution, invalid payload, 409 version conflict with comparable numbers,
    400 missing key, streamed results bound to the fingerprint, stored-draft key reuse,
    no plaintext key in the response or kernel calls, no write actions, duplicate-run 409,
    malicious endpoint rejected with zero upstream requests.
  - `tests/model-config-test-ui.test.ts` — 5 tests: request body key omission/replacement,
    `canRunTest`, cross-chunk NDJSON parsing, envelope error surfacing, abort semantics.
- `MemoryPanel`: `npm run typecheck` passed; `MemoryPanel/web`: `npm run build` passed.
- Browser acceptance: **31 Playwright assertions passed**
  (`MemoryPanel/tests/model-config/browser/model-config-test-acceptance.js`), covering
  admin-visible section, idle/through/failed/cancelled states, per-capability durations,
  `test_id` + fingerprint display, key omission for reuse vs. explicit replacement,
  `base_version` binding, form locked while running and editable after cancel, cancel
  resolving all three rows, double-click issuing exactly one request, and English + dark +
  390px rendering without horizontal overflow.
- Screenshot: `output/playwright/model-config-test-narrow-dark.png`.

## NOT_RUN

- Real GLM / DeepSeek / third-party provider calls (no credentials in this environment).
- Production deployment and live-instance verification.
- `MemoryCore` project-level typecheck (no root `tsconfig.json`); `build:plugin` was used.
