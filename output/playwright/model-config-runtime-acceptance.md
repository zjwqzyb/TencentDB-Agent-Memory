# Model configuration runtime consumption acceptance

Date: 2026-10-26
Tickets: `task-sgvn9khypm` (L1/L2/L3 + Skill), `task-sgvpapvanc` (Wiki/Knowledge),
`task-seckoawrd` (final integration of the model-configuration feature)
Branch: `feat/server_team` (working tree, not committed — several files also carry
unrelated in-progress edits, so staging them wholesale would mix another line of work)

## Runtime wiring

### Core (L1/L2/L3 + Skill)
- New single resolution point `MemoryCore/src/core/model-snapshot/`:
  `ModelSnapshotResolver.resolveForJob()` reads the Bearer-only active snapshot once and
  returns a frozen `{configId, version, provider, protocol, baseUrl, apiKey, modelId}`.
- `tdai-core.ts` resolves the snapshot **at job start** for L1/L2/L3 (scheduler and
  `runL*WithStore` paths) and builds a snapshot-backed `StandaloneLLMRunner`; the tool loop
  and every upstream call in that job reuse the same object.
- `skill-extractor.ts` resolves one runner per `extract()` job for query-gen + review.
- `paused` / `invalid` / read failure / managed row without an active snapshot →
  `MODEL_SNAPSHOT_PAUSED|INVALID|UNAVAILABLE`; only an instance that **never** had a
  managed config uses the deployment default (`cfg.llm`).

### Proxy
- `getInstanceUpstreamConfigState()` distinguishes `fresh / stale / unavailable` with
  `forceRefresh` + in-flight dedupe; `evaluateExtractionUpstream()` requires
  `enabled===true` **and** base_url + api_key + model_id.
- systemUser traffic force-refreshes so enable/disable is visible immediately even with a
  1h cache TTL; paused/incomplete/unavailable are blocked (409/503) instead of falling back
  to the global upstream; logs carry config id/version/provider/model/masked endpoint.

### Knowledge / Wiki
- `llm_binding` gained provider/protocol/model/config_source/config_id/config_version/
  fingerprint/snapshot_id/unavailable_reason (idempotent `ALTER TABLE` migration; legacy
  rows default to `config_source='deployment'`).
- `llm.ts` logs config id/version/provider/model/masked endpoint/outcome on every call and
  redacts upstream errors; a `chatWithTools` loop runs on the same client.
- Wiki job resolves the snapshot once in `module.ts`; body generation, merge, summary and
  tool calls all reuse it (summary no longer re-resolves — the previous version-mixing bug).
- Managed binding is fail-closed: paused / invalid / unreadable / stale fingerprint /
  version regression → `enabled:false` + reason, never the global model.
- Panel: enable success pushes the snapshot provenance to KS; a KS failure returns
  **502 `KNOWLEDGE_SYNC_FAILED`** so enable never reports success. Disable now also pushes
  the paused state immediately (added on top of the sub-agent delivery), and a KS failure
  there is logged without turning the authoritative pause into an error.
- Panel startup reconcile aligns KS with Core: paused/invalid/unreadable/version regression
  → disabled, legacy deployments untouched.

## Passed (all re-run by the parent agent)

| Suite | Result |
|---|---|
| `MemoryCore` `npx vitest run` | 10 files / 84 tests passed |
| `MemoryCore` `npm run build:plugin` | 8 files, build complete |
| `MemoryProxy` `npx vitest run` | 1 file / 14 tests passed |
| `MemoryKnowledge` `npx vitest run` | 22 files / 155 tests passed |
| `MemoryKnowledge` `npm run build` | 13 files, build complete |
| `MemoryPanel` `npx vitest run` | 11 files / 219 tests passed |
| `MemoryPanel` `npm run typecheck` | passed |
| `MemoryPanel/web` `npm run build` | passed |

Flakiness note: the first MemoryKnowledge full run had 1 failure in an unrelated legacy
test; three subsequent runs (including two consecutive clean 155/155) passed. Not
reproducible after the fact.

Key fixture-backed evidence (deterministic `node:http` OpenAI-compatible service):
- L1/L2/L3/Skill each hit the managed endpoint/model/credential; a trap global upstream
  recorded **0** requests in every case.
- Mid-job switch: in-flight job kept v1 (`sk-v1`) for both calls, the next job used v9.
- paused / invalid / unreadable → job fails, trap upstream 0 requests.
- Proxy: enabled=false / missing model / missing key / read failure classified separately;
  disable is visible immediately despite a 1h TTL.
- Wiki: body + merge + summary share one config version; restart reuses the persisted
  snapshot; pause fails closed; instance isolation enforced; logs contain the model and
  never the provider key.
- Panel: enable → KS carries provider/model/config id/version/fingerprint; KS failure → 502;
  disable → KS binding disabled immediately; manual re-sync (`.../resync-knowledge`) re-pushes
  the current snapshot and returns `KNOWLEDGE_SYNC_FAILED` (502) when KS is down.

## Browser acceptance (re-run, real built app + Chromium)

- Settings/draft flow: 25 assertions passed.
- Unsaved-config connection test: 31 assertions passed.
- Enable / pause flow: 25 assertions passed.
- Screenshots: `output/playwright/model-config-enable-state.png`,
  `output/playwright/model-config-test-narrow-dark.png`.

## NOT_RUN

- Real GLM / DeepSeek / third-party provider calls (no credentials provided).
- Production deployment and live-instance verification.
- Full Gateway HTTP end-to-end (real MetadataService + PipelineWorker + store): the runtime
  proof is job-level with a real HTTP runner against fixtures.
- MemoryCore project-level typecheck (no root `tsconfig.json`).
- `MemoryProxy` typecheck has one pre-existing unrelated error
  (`src/storage/factory.ts` → missing `@context-proxy/cost-guard`).

## Known trade-offs / follow-ups

1. When an instance has an active managed snapshot, Core calls that endpoint **directly**
   even if the deployment is configured with `llm.provider=proxy`; extraction traffic
   therefore no longer passes through Proxy metering (Proxy-side gating remains as a
   defence and is tested). This was chosen to guarantee "one pinned snapshot per job".
2. A failed enable→KS sync leaves Core already activated (retrying enable returns 409).
   Recovery is the manual 「重新同步知识服务」 action
   (`POST /api/v1/meta/instance-upstream/extraction/resync-knowledge`) or the Panel
   startup reconcile.
