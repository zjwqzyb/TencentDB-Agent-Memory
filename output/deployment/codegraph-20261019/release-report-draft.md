# CodeGraph Production Release — 2026-10-19

> Draft only. An initial candidate switch was rolled back after API validation found CodeGraph index-version failures. The final release is not complete.

## Release identity

- CodeGraph feature commit: `c8ccf254746374c69b0e8af43ff82d63596a0a8c` (`feat/server_team`).
- Deployment method: preserve the currently deployed Linux image and replace only the compiled Panel frontend assets.
- Initial candidate image digest: `sha256:5c16c14655dcef6221849d0d45e25c305544e0ef8d8e6bc672b19913e505215f`.
- Initial candidate container ID: `e71032725227a112e5a5a29841f6058e0fa9197ce421ad0040ff6c5fcdedd0e7`.
- Initial candidate status: briefly switched; rolled back after API validation reported repeated `version_expired` / `index_changed_during_query` failures during graph search.
- Current production status: previous Hub restored and healthy; final CodeGraph release remains pending a corrected candidate.

## Preserved production baseline

- Task UI overlay: `TaskWorkbench.tsx`, `IssueWorkbench.tsx`, `issue-workbench.css`, and `lib/api/issues.ts`.
- Panel API overlays: `meta-actions.ts` and `wiki-routes.ts`.
- Knowledge production patches: the ten files recorded in `baseline.json`; the unrelated Core issue-tracker changes are excluded.
- Pre-release frontend evidence: `baseline.json` records the old asset hashes matching the local production audit and the CodeGraph build hashes from clean `c8ccf254` plus the four task UI files.
- Runtime data, environment configuration, and metadata: release agent reported no changes to these during the candidate switch/rollback.

## Validation

- Initial candidate health check: Panel and Knowledge health endpoints returned HTTP 200 and the candidate container was healthy before rollback.
- Initial candidate API check: failed because graph-search repeatedly returned `version_expired` / `index_changed_during_query`; root cause and corrected validation are pending.
- Production UI checks: pending post-switch read-only Playwright review of the task workbench, CodeGraph `cg-4oc687yt`, all five modes, and node source display.
- Screenshots and sanitized evidence: pending; store under `output/playwright/`.

## Rollback

- Previous image/reference and asset backup: pending release agent report.
- Initial rollback: completed; previous Hub is healthy with Panel and Knowledge returning HTTP 200.
- Final candidate rollback procedure and result: pending corrected release attempt.

## Notes

- This report will contain no credentials, cookies, user keys, or other secrets.
- Fill in only after candidate review and production checks complete; then move the reviewed report into `docs/qa/codegraph/production-release-2026-10-19.md` for the independent documentation commit.
