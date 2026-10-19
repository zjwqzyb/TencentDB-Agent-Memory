# Bounded hierarchical CodeGraph clusters

Status: implemented; parent acceptance pending.

Clusters are deterministic directory/file/symbol groups over the same versioned
SDK index. They do not claim automatic community detection. Source verification,
relation selection, opaque snapshot IDs, keyset scans and hard work/memory
budgets reuse the dependency aggregation engine; dependencies keep their accepted
outgoing-only scope semantics.

## Scope, levels and identity

`mode=clusters` defaults to `groupBy=directory`, `moduleDepth=1` and imports.
`groupBy=file` drills a directory; `groupBy=symbol` requires a nonempty path
and returns indexed real nodes in that scope, including SDK file nodes when
those are relationship endpoints. An exact file scope is the normal UI drill.
The segment-aware scope also supports a directory for a bounded symbol view.
`.` means root-direct files, while an empty scope means the whole repository.
No indexed members means an empty graph; unindexed empty filesystem directories
are not invented.

A relation is included when either its source or its internal target is in
scope. Incoming and outgoing endpoints outside scope remain directory boundary
aggregates with `aggregate.boundary=true` and incomplete membership counts.
External/unresolved references remain explicit boundary placeholders. Unresolved
references from outside scope have no proven inside target and are not invented
as incoming relations. Directory depth is absolute from repository root.

Aggregate identities depend on resolution, level and represented path, within
the asset snapshot, rather than the current drill scope. A module returned as a
boundary has the same ID as that module in the overview. Real symbols retain
their normal node IDs and support graph-node/source; aggregate IDs do not.
`clustering` describes the effective scope, level, depth, `boundaryPolicy=both`
and root-to-current breadcrumbs. A selected real `nodeId` in scope is reserved
before scanning so search can locate a member beyond the first page. `focusId`
is only set when that exact real node occurs in the response; an explicit
nonintersecting scope never produces a dangling focus.

## Counts and symbol edges

Directory/file relationships retain the accepted unique declaration-site plus
target-file count. Symbol relationships additionally preserve distinct visible
source/target endpoints, so one import declaration with two resolved target
symbols creates both edges. Calls use the same endpoint policy with their
indexed call-site location. Duplicate raw SDK edges for the same site and
visible endpoints still count once.

`aggregation.distinctSiteCount` is the cumulative number of unique canonical
site/target-file keys in the query's represented scope, including internal
relationships. It provides cross-level reconciliation. Symbol `edge.count`
counts sites on that edge; summing symbol edge counts can count a shared
declaration more than once and is not the whole-view distinct total. Counts
are current scanned data when `complete=false`; pagination always replaces
cumulative results, never adds them. An evidence-only query reports the sites
for its selected edge and keeps its own cursor. Its evidence contains the
original canonical real source/target IDs and verified source location.

SCC includes real symbol nodes and real self-loop edges. Aggregate-internal
counts do not become invented self-loops. Reported cycles describe the observed
visible graph at its current abstraction level; folded placeholders are excluded.
Partial scans cannot establish that no cycle exists. Static extraction remains
incomplete even after a full index scan, including the SDK 1.6.2 star-reexport
gap documented in the dependency ADR.

## Bounded folding and diagnostics

The deterministic node scan reserves up to two slots for remaining in-scope
members and remaining boundary endpoints. These are explicit `kind=collapsed`,
`aggregate.collapsed=true` placeholders. Their membership counts accumulate,
while `aggregate.complete` stays false and the response declares
`collapsed_node_budget`. At an extremely small limit, a mixed boundary bucket
may be necessary and is declared `cluster_boundary_collapsed`. The UI should
search or narrow scope, not repeatedly drill the identical placeholder scope.
A real selected symbol receives priority over folded members.

Edges to folded members retain their visible endpoints and count; relationships
wholly inside a folded aggregate increment its internal count. Folding does not
claim that omitted individual members or their exact topology are rendered.
Repeated drill/collapse uses stable identities. Evidence reconstruction follows
the same deterministic node scan before scanning edges, so it recovers the same
folded group identities. The maximum edge count, 8,192 dedup-site bound and 1 MiB
cursor bound still apply and explicitly stop a query that cannot fit.

Resolved-import binding diagnostics are cumulative, deduplicated by indexed
reference ID, up to edgeLimit (default 300, max 1,500). Overflow returns an explicit
`unresolved_diagnostic_budget` warning and incomplete/truncated result even if
the scan reaches its end. It does not silently drop earlier pages or inflate
import counts. All index reads, including lookups and misses, remain within
2,000 row operations; source reads remain 2 MiB cumulative per request.

## Verification

```sh
cd MemoryKnowledge
/Users/zj/.hermes/node/bin/node node_modules/vitest/vitest.mjs run src/engines/code/structured-clusters.test.ts src/engines/code/structured-aggregation.test.ts src/engines/code/structured-aggregation-sdk.test.ts
/Users/zj/.hermes/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

The cluster suite covers both boundary directions at all levels, stable IDs,
real source nodes, endpoint-preserving import/call counts, symbol SCC/self-loops,
root/empty/disjoint scopes, selected late symbols, folding, replay/scope/version
isolation, cumulative diagnostics and overflow. Its 5,000-symbol/15,000-edge
fixture asserts every page's work and output bounds. The real SDK fixture
asserts that one declaration resolving `bee` and `second` preserves both real
targets and that file/symbol distinct totals match; it also checks true evidence
IDs and repeat drill results. Temporary repositories are removed in finally.
HTTP/Panel/browser integration and timing measurements are separate evidence
owned by the integration agents, not substitutes for these semantic tests.
