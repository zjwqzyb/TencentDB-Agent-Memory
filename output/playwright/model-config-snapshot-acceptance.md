# Managed model snapshot, test gate, enable/pause acceptance

Date: 2026-10-26
Ticket: `task-sgu5azt1su` — Memhub 模型配置：测试门禁的启用、停用与不可变快照
Branch: `feat/server_team` (working tree, not committed — the same Core files carry
unrelated in-progress edits, so staging them wholesale would mix another line of work)

## What was built

### Storage
- New `snapshot_json` column on the extraction row (SQLite + MongoDB, with an
  `ALTER TABLE` fallback like `draft_json`). Contents:
  `{ active: {snapshot_id, version, provider, base_url, api_key, model_id, description,
  activated_at} | null, test: {test_id, fingerprint, passed, tested_at, expires_at,
  capabilities} | null }`.
- Draft stays in `draft_json`; the legacy active columns mirror `snapshot.active` on the
  same atomic UPDATE so the Proxy runtime path is unchanged.
- Internal list now strips both `draft_json` and `snapshot_json`; plaintext keys only
  leave Core through the dedicated internal endpoint.

### Test gate
- Single canonical fingerprint: `sha256:<16>` over
  `provider | base_url (trailing slashes stripped) | model_id | sha256(api_key)[0:16]`.
  It deliberately excludes `version` and `description`, so a remark-only edit keeps valid
  evidence while any connection-field change invalidates it. Shared vector
  `{deepseek, https://api.deepseek.com, deepseek-chat, sk-test}` = `sha256:0f4a34ca2735badd`
  is asserted in **both** Core and Panel test suites.
- Panel records evidence after every non-cancelled probe; Core stores it without bumping
  the config version.
- `enable` requires `expected_version` + `test_id`; missing/shape errors →
  `TEST_REQUIRED`, mismatched/failed/expired fingerprint or wrong `test_id` →
  `TEST_STALE` (HTTP 409), active state untouched in both cases.

### Activation / pause
- `enable` atomically writes the active columns + a `snap_<ulid>` snapshot, sets
  `enabled=true`, bumps version; old holders keep their previous snapshot object.
- `disable` keeps draft + snapshot and sets `enabled=false` → `paused: true`; managed
  configs never silently fall back to the deployment model.
- `extraction/update` can no longer flip `enabled` (returns `USE_ENABLE_DISABLE_ENDPOINT`);
  `toggle` only pauses.
- Service-to-service resolver `POST /v3/internal/meta/instance-upstream/extraction/snapshot`
  (Bearer only, not in the Panel allowlist) returns `ready` (full snapshot with plaintext
  key), `paused`, `invalid` (+reason) or `config_unavailable`.

### UI
- Status now distinguishes 已启用 / 草稿·未启用 / 已停用（受管配置）/ 部署配置.
- 「启用配置」is gated on recorded passing evidence that still matches the draft, and on
  having no unsaved form edits; each blocked case has its own hint.
- 「停用配置」shows an explicit paused banner explaining there is no fallback.
- 「重新同步知识服务」 recovers from a failed enable→KS sync without restarting Panel.
- After a probe the panel refreshes `config` only (never the form) so the gate picks up
  `test_id` / `matches_current` without discarding unsaved input.

## Passed

- `MemoryCore`: 4 files / 38 tests passed
  (`instance-upstream-extraction` 21 incl. evidence/TTL/forged id/remark-only/atomic
  enable/disable/409 detail/legacy resolver/4 resolver states/admin gate;
  `model-config-fingerprint` 3; `sqlite-adapter` 9; `mongodb-adapter` 5 in-process).
- `MemoryCore`: `npm run build:plugin` passed.
- `MemoryPanel`: 9 files / 200 tests passed; `npm run typecheck` passed;
  `MemoryPanel/web` `npm run build` passed.
- Browser acceptance (Chromium, real built app):
  - enable/pause flow: **25 assertions passed** (incl. manual knowledge re-sync)
    (`MemoryPanel/tests/model-config/browser/model-config-enable-acceptance.js`).
  - connection-test flow regression: **31 assertions passed**.
  - original settings/draft flow regression: **25 assertions passed**.
  - Screenshot: `output/playwright/model-config-enable-state.png`.

## NOT_RUN

- Real GLM / DeepSeek / third-party provider calls.
- Production deployment and live-instance verification.
- MemoryCore project-level typecheck (no root `tsconfig.json`); `build:plugin` used.
