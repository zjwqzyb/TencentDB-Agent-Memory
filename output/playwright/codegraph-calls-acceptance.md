# Calls workspace browser acceptance

Date: 2026-10-19. Task: `task-efys0u4tc2`. Reviewer: acceptance_prep.

Result: 49 scripted assertions passed. No remaining calls workspace blocker
was found in the assigned browser scenarios. Task status is managed by the
parent reviewer; this report does not change tracker state.

## Scope and environment

- Real production CodePage / CodeDetailView / graph components in Vite on
  `http://127.0.0.1:15173/#/code`; unrelated port 5173 was untouched.
- Browser fixture intercepts HTTP APIs. Browser evidence establishes UI
  behavior, not SDK extraction, backend authorization, or live account setup.
- Real SDK 1.6.2 → Knowledge Hono random-port HTTP → HttpKnowledgeClient →
  Panel route integration is independently tested by
  `MemoryPanel/tests/knowledge/code-graph-live-chain.test.ts`.
- Chrome 155.0.8059.82; Node 22.23.0; arm64 MacBookPro17,1, 8 cores, 16 GiB.
- Desktop 1600×1000, resized canvas at 1400×900, narrow 375×812.
- English and Chinese; Tea `theme-mode` toggles on both html and body.

## Executed results

| Script | Passed | Checks |
|---|---:|---|
| code-graph-smoke.js | 7 | Symbol ambiguity, Enter selection, source version, 5 distinct loop/reverse/parallel edges, in/out/both expansion + undo, kind filter, focus return |
| code-graph-races.js | 8 | Catalog/source expiry cancels stale graph, sparse continuation, collapse restores pagination request, empty append preserves graph, stale focus/asset isolation |
| code-graph-states.js | 17 | Reset removes old results immediately; fresh version IDs; empty/unindexed/building/failed/unsupported/not_found; 403/404/network; unavailable source; truncation; legacy search/explore and sync version/cache/link |
| code-graph-visual.js | 13 | Real canvas hit after zoom/fit/resize, evidence path toggle, same-node refocus source, 375px drawers' nonmodal semantics/focus/Escape, narrow search→source, English, no-WebGL keyboard fallback |
| code-graph-theme.js | 4 | html/body dark/light switches redraw labels using effective Tea token |

Commands are in `MemoryPanel/tests/knowledge/browser/README.md`. Each script
prints its successful assertion list; final theme checks were rerun after the
last canvas hover drawing fix. Parent independently verified native tab
keyboard navigation.

## Defects closed during acceptance

- Neighbor refocus stored selected neighbor instead of old graph focus:
  corrected by graph_ui; focus return passed.
- Reset left stale catalog selectable while fresh tree was delayed:
  corrected by graph_ui; three explicit reset assertions passed.
- Tea Drawer lacked Escape and dialog/focus behavior: graph_ui added
  nonmodal dialog semantics, initial focus and trigger restoration; passed.
- Canvas theme observer omitted `theme-mode`, and read only root tokens:
  graph_ui now observes root/body and reads effective container tokens;
  all four theme switches passed.
- Selected Sigma label was white text on white background in dark theme:
  graph_ui supplied theme-aware hover rendering; latest dark screenshot was
  visually inspected and selected `entry` is readable on a dark background.

## Evidence

- `codegraph-calls-desktop.png`: relationship table, loops and parallel rows.
- `codegraph-races-pass.png`: race suite completion.
- `codegraph-states-pass.png`: new-version source after sync.
- `codegraph-canvas-pass.png`: real canvas and source after resize/click.
- `codegraph-narrow-pass.png`: stable 360px source drawer in 375px viewport.
- `codegraph-english-dark.png`: final dark graph; selected label contrast fixed.
- `codegraph-no-webgl.png`: accessible table fallback with keyboard-selected
  helper source.

Desktop/table, narrow, final dark and no-WebGL screenshots were visually
inspected. Historical `*-failure.png` files are debugging artifacts, not the
final state. No video/trace is claimed.

## Limits and existing behavior

- Narrow graph drawers fit and work. The existing application header overlaps
  and the persistent navigation consumes substantial width at 375px. This
  shell behavior predates the graph workspace and was reported to the parent;
  the report does not claim the whole application is mobile optimized.
- Drawers are intentionally nonmodal (`aria-modal=false`); keyboard can reach
  background content. Focus trapping was explicitly excluded by the reviewer.
- No-WebGL check produced no graph runtime exception. Console contained only
  the three known Tea/React forwardRef and findDOMNode deprecation messages.
  Error-state tests intentionally cause failed HTTP/network console entries.
- This small deterministic fixture does not establish 500-node performance.
- Only calls UI was accepted here; subsequent graph modes require their own
  task acceptance.

## Final regression after all five modes were integrated

On 2026-10-19, acceptance_prep created the independent Playwright session
`codegraph-final-calls` after graph_ui confirmed production edits were stable.
Node 22.23.0 and Chrome 155.0.8059.82 ran the existing fixture against the same
15173 production UI. All five suites passed again: smoke 7, races 8, states 17,
visual 13, theme 4, totaling **49/49**. This was a fresh browser session rather
than reuse of another reviewer's active session. No production change was
needed and tracker status was left to the parent reviewer.

The first states run stopped after 13 checks because it expected the previous
generic truncation message. The current UI correctly distinguishes unfinished
scanning and showed “本次扫描尚未完成，可继续加载剩余关系或证据。” plus the
continuation button. The script now asserts that specific message; the entire
17-check states suite then passed. The initial output is retained as
`codegraph-final-states-old-label.log`, explicitly a superseded test-selector
failure, not a final passing result.

Exact replay from the repository root (each command uses the same session):

```sh
export PATH=/Users/zj/.hermes/node/bin:$PATH
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-final-calls open about:blank --headed
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-final-calls run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-fixture.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-final-calls run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-smoke.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-final-calls run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-races.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-final-calls run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-states.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-final-calls run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-visual.js --raw
bash /Users/zj/.codex/skills/playwright/scripts/playwright_cli.sh -s=codegraph-final-calls run-code --filename MemoryPanel/tests/knowledge/browser/code-graph-theme.js --raw
```

Actual JSON assertion logs are `codegraph-final-{smoke,races,states,visual,theme}.log`
in this directory. The screenshot filenames above were refreshed by these
final runs. Narrow drawer, no-WebGL table and final dark selected-node labels
were visually inspected again. The existing 375px application header overlap
remains the previously recorded shell limitation. These fixture assertions
remain UI evidence, separate from SDK/HTTP integration tests.
