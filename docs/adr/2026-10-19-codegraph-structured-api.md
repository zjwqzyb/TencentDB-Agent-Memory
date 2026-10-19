# CodeGraph structured viewer API

Status: implemented first slice (calls, node discovery/detail/source). This document records the initial API boundary. Later impact/hierarchy behavior and long-file evidence windows are documented in `2026-10-19-codegraph-impact-hierarchy.md`; dependency aggregation has a separate implementation and verification. Unsupported modes remain explicitly capability-gated.

## Contract and deployment

The canonical wire types are `contracts/code-graph.d.ts`. Run `node tools/sync-code-graph-contract.mjs` after editing them and `node tools/sync-code-graph-contract.mjs --check` before review. Generated, identical declarations live inside Knowledge, Panel and web `src` boundaries. Each existing project/Docker build therefore remains self-contained; these imports are type-only and introduce no runtime package or outside-build-context dependency.

Panel exposes `POST /api/v1/knowledge/code-graph/{graph,graph-search,graph-tree,graph-node,graph-source}`. Knowledge exposes the same suffixes under `/v3/code-graph/`. All accept `code_graph_id` plus `CodeGraphRequest`. The Panel client method is `codeGraphStructured(assetId, action, request)`; browser methods are `knowledgeApi.code.graph/graphSearch/graphTree/graphNode/graphSource(assetId, request, signal?)`. The optional AbortSignal cancels browser requests.

Existing search/explore/callers/callees/impact/node/status/files text tool contracts are unchanged. No structured graph is reconstructed from Markdown.

- `graph-search`: bounded substring search across name, qualified name and path; `nodeKinds` and `scopePath` narrow results. Duplicate names remain distinct nodes with path/type/lines.
- `graph-tree`: bounded file-node listing, whose file paths let the client construct directory hierarchy. It is paginated; it never implies all repository paths were loaded.
- `graph-node`: one indexed node. `nodeId` and `indexVersion` are required.
- `graph-source`: indexed node's source, requiring both IDs. Source is read from the asset root only and verified against the SDK files table's SHA-256. At most 2 MiB are read and at most 300 source lines returned. A changed worktree yields `version_expired`; unsafe/missing/oversize files yield `source_unavailable` without file content.
- `graph`: mode defaults to calls, direction to both, depth to one. Any node-bearing request requires `indexVersion`. No focus returns an empty selection prompt; unsupported modes return `unsupported`. Calls always point caller → callee, including self loops, reverse edges and distinct parallel edge IDs.

Responses carry state, asset/version/commit/branch/index time, capabilities, nodes/edges with evidence, focus, truncation reasons, warnings and nextCursor. HTTP authorization/not-found/input failures stay errors; graph availability states are successful envelopes with explicit states. A corrupt or unreadable DB is `failed`, a missing DB is `unindexed`; they are not represented as empty graphs or unsupported capability. A failed schema/version capability gate is unsupported.

## Verified SDK boundary

As of 2026-10-19 the installed platform package is **@colbymchenry/codegraph 1.6.2**. `structured-sdk.test.ts` builds a real temporary TS/JS index and verifies these facts:

| Extraction | Direction/evidence | Current verified viewer support |
| --- | --- | --- |
| TypeScript / JavaScript calls | Caller → callee, indexed source location | calls supported |
| TypeScript imports | Actual imports edges with verified declaration source anchors | dependencies and directory/file/symbol clusters; bounded counts and evidence |
| TypeScript class extends / JavaScript class extends | Child → Base | hierarchy supported for verified class relations |
| TypeScript implements | Child → interface | hierarchy supported, including multiple interfaces |
| TypeScript interface extends | SDK 1.6.2 did not emit tested relations | explicitly unsupported/partial with a capability warning |
| Reverse static dependencies | Actual incoming calls/imports/extends/implements/references | bounded potential impact and real evidence paths |
| Same-named TS functions in different files | Distinct SDK IDs/paths | searchable/detail/source supported |

The table reflects the final implemented modes, not just the original calls slice. See `2026-10-19-codegraph-impact-hierarchy.md`, `2026-10-19-codegraph-dependency-aggregation.md` and `2026-10-19-codegraph-hierarchical-clusters.md` for mode semantics, SDK omissions and aggregation completeness. Cluster grouping is directory-based; it is not semantic community detection. The initial five-endpoint API and its security boundaries remain shared.

Only 1.6.2 and the required schema/adjacency indexes are enabled. Other installed versions fail closed as unsupported. `MemoryKnowledge/package.json` now pins the SDK to exact `1.6.2`: the previous `^1.2.0` range could select a newer, unverified SDK during the Dockerfile's fresh `npm install`, leaving a successfully built viewer unsupported. This pins the verified SDK choice; it does not claim a full transitive-dependency lock or a production rollout. Supported language claims are limited to TypeScript and JavaScript; discovery flags other languages as unverified, and a calls focus in an unverified language returns unsupported. This is a local installed-version verification, not evidence that a production deployment is running that version. Static extraction does not establish runtime completeness.

The SDK's public adjacency APIs return unbounded arrays. The adapter therefore uses the SDK's public `getDatabasePath()` resolver and a separate read-only SQLite connection, checks table columns/index availability, and executes parameterized keyset queries. `EXPLAIN QUERY PLAN` tests confirm composite source/target+kind indexes and no temporary sort for the adjacency queries. It never calls an unbounded SDK traversal followed by `slice`.

## Budgets and continuation

Defaults are 100 nodes / 300 edges per response; accepted maximums are 500 / 1500 and five hops. A traversal has a cumulative 500-node / 1500-edge cap. Each request examines at most 2,000 data-row operations, including node lookups. Metadata/schema checks are separate small fixed-shape queries. Search scans primary-rowid windows and can return an empty page with `scan_budget` and a continuation when a match is farther ahead. Clients must continue pagination rather than treating such a page as proof of no match.

Cursors are opaque, server-held immutable traversal snapshots, bound to the asset, index version, normalized query and ten-minute TTL. The process holds at most 128; expiry/eviction/restart returns `version_expired` with `cursor_expired_or_query_changed`, instructing a fresh query. Repeating a cursor reproduces the same data page. Filter and JSON property ordering do not change its query identity. Node endpoints may repeat between pages so every edge can be rendered; clients merge nodes and edges by stable ID and must enforce the visible cumulative cap. A cumulative traversal budget has no continuation: focus another node to explore a different bounded neighborhood.

## Consistency and security

Node/edge IDs are opaque and scoped to asset plus index version. Version derives from the store generation (incremented before sync/build), last indexed time and SQLite/WAL file identity/change markers. Every query runs in a read transaction and verifies the snapshot before returning; routes re-read status/version after awaited SDK setup and after query completion. Replacing/rebuilding a DB cannot label new rows with an old snapshot. Old cursors and node IDs are rejected. The source hash independently protects against the fetch-before-reindex window and local worktree edits.

Every new Panel route runs the existing `requireKnowledgeRead` ACL with no in-flight-owner fallback. Missing metadata, wrong team, restricted assets and nonmembers cannot query a ready orphan Knowledge resource. Knowledge resolves `(service_id, code_graph_id)` before opening any filesystem path. Neither body team IDs nor caller-provided paths can select an asset directory; source paths originate only from a node inside that asset's index. Realpath/root boundary and descriptor identity checks reject escaping symlinks; bounded descriptor reads prevent a growing file from causing unbounded reads. Source errors do not expose absolute server paths.

## Verification

Run with the project's supported Node 22 runtime (the development shell may otherwise select an incompatible Node 26 ABI for better-sqlite3):

```sh
node tools/sync-code-graph-contract.mjs --check
npm --prefix MemoryKnowledge run typecheck
MemoryKnowledge/node_modules/.bin/vitest run MemoryKnowledge/src/engines/code/structured.test.ts MemoryKnowledge/src/engines/code/structured-sdk.test.ts MemoryKnowledge/src/routes/code-graph-structured.test.ts
MemoryPanel/node_modules/.bin/tsc -p MemoryPanel/tsconfig.json --noEmit
MemoryPanel/web/node_modules/.bin/tsc -p MemoryPanel/web/tsconfig.json --noEmit
```

Adapter tests exercise dense 600-node fan-out and sparse 5,000-node search, SQL plans, paging/retry, duplicate names/overloads, recursion/reverse/parallel edges, missing nodes, cross-asset and old-version rejection, file hash mismatch, symlink escape, source budget, unsupported language/schema, concurrent DB replacement, route service isolation and state/input failures. The separate Panel authorization suite checks all five endpoints through a real HTTP client. The live-chain integration suite uses real SDK indexing, Knowledge routes, HTTP transport and Panel routes to validate calls/discovery/detail/source and legacy text compatibility. Later whole-feature QA owns the planned 5,000-node / 15,000-edge performance acceptance and browser interaction measurements; this API slice does not claim those measurements.
