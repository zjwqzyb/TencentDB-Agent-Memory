# Model configuration settings acceptance

Date: 2026-10-26
Final implementation head: `3c9ad32`

Scope: UI acceptance through the real Vite app with mocked Panel HTTP responses. This does not prove live provider reachability or production deployment; backend persistence and authorization are covered separately.

## Passed

- 25 Playwright assertions passed from `MemoryPanel/tests/model-config/browser/model-config-acceptance.js`.
- Draft create/update requests include `draft: true` and never send an activation flag.
- The active/deployment source is unchanged when a draft is created.
- The API key is sent once, is absent from local storage, and the key input is hidden after save.
- Provider presets do not overwrite a custom Base URL.
- Editing the endpoint resets the prior key-reuse confirmation.
- In-flight save disables the action; repeated programmatic clicks create only one request.
- A 409 response preserves local input and shows the submitted/current versions.
- Closing with unsaved input and switching tabs both require explicit discard confirmation.
- A saved draft is restored after a full reload.
- Normal members cannot see the model-configuration tab.
- Chinese/English, dark theme, and 390px viewport render with a centered dialog, balanced margins, and no horizontal overflow.
- Screenshot: `output/playwright/model-config-narrow-dark.png`.

## Related automated checks

- Clean implementation worktree: `MemoryCore` 3 test files / 24 tests passed; `npm run build:plugin` passed.
- Clean implementation worktree: `MemoryPanel` 5 test files / 140 tests passed; `npm run typecheck` passed.
- Final worktree: `MemoryPanel` 6 test files / 149 tests passed after the UI review fixes.
- `MemoryPanel/web`: `npm run build` passed.

## NOT_RUN

- Real GLM/DeepSeek/third-party calls.
- Production deployment and live-instance verification.
