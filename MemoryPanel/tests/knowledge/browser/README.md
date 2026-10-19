# CodeGraph browser acceptance

This harness opens the production `CodePage` and `CodeDetailView` in Vite. It
intercepts HTTP APIs with deterministic fixture data. It proves UI behavior,
not SDK extraction or backend authorization. The independent
`../code-graph-live-chain.test.ts` covers the real SDK/Knowledge/Panel chain.

Use the UI developer's existing server at `http://127.0.0.1:15173`; leave the
unrelated port 5173 process alone. No production account or service is needed.

From the repository root:

```sh
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance open about:blank --headed
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-fixture.js
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance snapshot
```

The fixture creates two repositories and four symbols: `entry` in `main.ts`,
`helper`, `upstream`, and another `entry` method in `other.ts`. Calls include a
self-loop, reverse calls, two independently identified parallel calls, and a
second-hop symbol. No mutations are sent to a real backend.

The intercepted `/__codegraph-test` endpoint configures a running session:

```js
await page.evaluate(async () => fetch('/__codegraph-test', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ delayByAction: { graph: 1200 }, clearRequests: true }),
}).then(response => response.json()));
```

`GET /__codegraph-test` returns all request paths and bodies plus current
configuration. Configurable fields:

- `version`: `v1` initially; a sync changes it and repository commit metadata.
- `responseState`: global structured response state, initially `ready`.
- `actionState`: per-action state, e.g. `{ "graph-source": "version_expired" }`.
- `delayByAction`, `delayByNode`, `delayByAsset`: delayed responses in milliseconds.
- `httpStatus`: 403/404/500 or 0 to abort the request as a network failure.
- `sourceUnavailable`: unavailable source while graph remains ready.
- `truncated`: response with a continuation cursor.
- `sparseSearch`: first search page is empty with a continuation cursor.
- `emptyContinuation`: subsequent cursor request returns an empty terminal page.
- `clearRequests`: reset recorded requests before a scenario.

For no-WebGL fallback, set `localStorage['codegraph-test-no-webgl']='1'` and
reload. Remove the key and reload to restore normal canvas behavior. Use
`tdai-memory.lang` (`zh-CN` or `en-US`) to select the language before reload.
Only the isolated Playwright session's local storage is affected.

Required interaction checks:

1. Enter repository from the real list; open the repository graph tab; search
   and disambiguate both `entry` results by path/kind/line.
2. Select a function, inspect source, expand in/out/both, undo expansion, select
   another focus and return; confirm loops/reverse/parallel rows are retained.
3. Filter node/edge kinds, zoom/fit, use the relationship list and keyboard;
   check 390px width, English, Tea dark theme, and no-WebGL fallback.
4. Repeat original text search/explore and sync; ensure graph/source use the
   new version after sync, and the old response cannot overwrite the new asset.
5. Delay graph response while catalog expires; delay a previous focus/asset;
   expire only the source response; ensure stale graph/source never revives.
6. Expand, undo, continue the previous page; inspect recorded cursor request
   to ensure it uses the previous focus/direction. Continue sparse empty search
   pages and append empty graph pages without hiding existing results.
7. Exercise empty/unindexed/building/failed/unsupported/version-expired,
   forbidden/deleted/network states and budget/truncation messages.

Store screenshots, traces and the actual acceptance report under
`output/playwright/`. Do not claim an unrun scenario passed.

Completed on 2026-10-19 with Chrome 155.0.8059.82 and Node 22.23.0:

```sh
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-smoke.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-races.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-states.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-visual.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-acceptance run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-theme.js --raw
```

Run these in order after installing the fixture in a fresh named browser
session. The first three use Chinese labels; visual and theme scripts reset
their own language/viewport. Each prints the actual successful assertions.
If reusing a session left in English by visual/theme, set
`localStorage['tdai-memory.lang']='zh-CN'`, remove
`codegraph-test-no-webgl`, reload, and re-enter the alpha asset before smoke.
The fixture control state must also return to defaults when restarting a
subset. Installing the fixture again resets its API state.

Results: smoke 7, races 8, states 17, visual 13, theme 4 = 49 passing assertions.
`output/playwright/codegraph-calls-acceptance.md` records scope, fixes, evidence
and limitations. Screenshots ending in `failure` are historical diagnostics,
not final acceptance evidence. The theme script is the final dark screenshot
producer, after live root/body theme switching checks.

## Impact, dependencies, hierarchy

Use a fresh fixture before each script. The scripts reset language to Chinese;
`mode-states` switches to English for its last assertion.

```sh
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-modes open about:blank --headed
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-modes run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-fixture.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-modes run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-modes.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-modes run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-fixture.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-modes run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-mode-states.js --raw
```

Results on 2026-10-19, Chrome 155.0.8059.82: modes 30, mode-states 11 = 41 assertions.
The fixture models reverse impact paths across pages, real directed class
inheritance and interface implementation, directory/file aggregate counts,
confirmed cycle membership, real-node evidence and same-file sourceLine 700.
This does not establish SDK extraction coverage. Actual SDK 1.6.2 does not
extract TypeScript interface extends or all star re-exports; UI reports both
limitations when the server supplies them.

Additional fixture controls: `modePages` splits impact and cumulative
aggregation pages; `dependencyPartial` returns incomplete aggregation without
confirmed cycles; `extraWarnings`, `extraReasons` and `extraCursor` exercise
specific coverage/budget notices. Dependencies replace cumulative aggregate
pages; impact evidence merges by identity with prior-page edges.

## Directory clusters and performance

```sh
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-clusters open about:blank --headed
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-clusters run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-fixture.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-clusters run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-clusters.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-perf open about:blank --headed
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-perf run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-fixture.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-perf run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-performance.js --raw
```

Clusters passed 21 assertions on Chrome 155.0.8059.82. They cover directory /
file / symbol navigation, keyboard selection and collapse, breadcrumbs,
real-symbol search prioritization, both boundary directions, stable canvas
lifecycle, distinct-site reconciliation, idempotent scopes, cumulative paging,
late mode responses, empty scopes, budget placeholders, and snapshot expiry.
`clusterCollapsed: true` adds an explicit budget remainder placeholder.

The performance script embeds an actual structured adapter response from the
5000-node/15000-edge synthetic SQLite benchmark (100 nodes / 300 edges returned), remapping only asset/version/node IDs for the
isolated HTTP fixture and disabling its opaque continuation. It measures browser
ResourceTiming `responseEnd` to an actual canvas node selection updating its
detail title plus two animation frames. It includes Playwright click latency;
network and backend extraction time are excluded. One first graph mount after
app load plus 30 subsequent graph remounts are recorded. This synthetic topology was not generated by the SDK parser. No CPU throttling
or animation override is applied. Raw results are persisted in
`docs/qa/codegraph/ui-performance-2026-10-19.json`.

## Live local structured HTTP chain

Start the local test server from `MemoryPanel` (Node 22):

```sh
CODEGRAPH_LIVE_METADATA=/tmp/codegraph-live-browser.json ./node_modules/.bin/tsx tests/knowledge/live-codegraph-server.ts
```

It uses random loopback ports, creates a temporary Git repository and SDK index,
and prints/writes metadata when ready. Leave it running for browser acceptance.
From the repository root, in another terminal:

```sh
python3 MemoryPanel/tests/knowledge/browser/prepare-live-fixture.py /tmp/codegraph-live-browser.json
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-live open about:blank --headed
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-live run-code --filename /tmp/code-graph-live-fixture.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-live run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-live.js --raw
```

The generated transient fixture forwards every structured POST through real
Panel HTTP → Knowledge HTTP → SDK. Browser identity/repository catalog and
server metadata/ACL remain explicit local fixtures. The live server's real
index version, Git commit, node/edge IDs and source bytes are preserved. No
production service/account is modified. Send SIGTERM or SIGINT to the test
server when finished; its handler closes listeners/index and removes the
temporary repository. Regenerate the transient fixture after every server
restart because ports and snapshot metadata change.
