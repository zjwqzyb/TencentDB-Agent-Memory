# Bounded CodeGraph dependency aggregation

Status: implemented dependencies backend. Clusters use the separate policy in
`2026-10-19-codegraph-hierarchical-clusters.md`.

The dispatcher in `structured.ts` owns authorization-independent query
validation, snapshot identity, SQLite read transactions and opaque cursors.
`structured-aggregation.ts` owns dependency grouping and counting. Panel's
existing structured-route ACL remains mandatory before the Knowledge query.

## Ownership, scope and drill-down

`graph` with `mode=dependencies` accepts `groupBy=directory|file` (directory by
default), `moduleDepth=1..5` (one by default) and `scopePath`. Directory depth
is measured from the repository root. For example, `src/a/main.ts` belongs to
`src` at depth one and `src/a` at depth two; `index.ts` belongs to `.` at every
directory depth. File grouping uses the full repository-relative file path,
so equally named files in different directories remain distinct.

An absent scope selects the whole repository. Scope `.` selects only files
directly in the repository root. Other scopes select an exact file or files
under that directory, with a segment boundary (`src` does not match `src2`).
If a real node ID is supplied without an explicit scope, its file is the
source scope. Dependencies are **outgoing from the source scope**; targets
outside it remain visible. Counts on those outside nodes are not represented
as complete membership counts. This outgoing boundary is specific to
dependencies; clusters drill-down preserves incoming
boundary connections and does not reuse this source-only filter.

A directory node drills into `groupBy=file, scopePath=node.aggregate.path`.
A file drills into the existing `graph-search` with its exact file path,
which returns real indexed symbols. Aggregate IDs are distinct, opaque,
asset/snapshot-scoped hashes, not real source nodes. They cannot be passed off
as graph-node/source IDs. `dependencyEvidence.sourceId` and `targetId`, when
present, are real canonical snapshot node IDs suitable for detail/source
requests. Module/file memberships use `fileCount` and `symbolCount`; the latter
counts indexed non-file nodes, including import declarations.

## Relation and count semantics

The default relation is `imports`. A caller may explicitly select `calls`
instead. The two kinds are separate queries and have different `countMetric`
values. Mixed kinds and `contains` are unsupported; they never inflate import
counts. `groupBy=symbol` is explicitly unsupported for this mode; symbol
discovery uses the endpoint described above.

The verified SDK 1.6.2 emits a file-target edge and multiple binding-target
edges for one import. Some named reexports emit only symbol-target edges.
Targets therefore map to their actual indexed file, and the import count key
is **source file + verified declaration start line/column + target file**.
Different declarations on the same line remain distinct; multiple named
bindings from one declaration to the same file count once. Calls instead use
their indexed call-site line/column plus target file. Internal dependencies
within a group increment `aggregate.internalCount`; they do not become fake
cross-module self-loops.

Every aggregate edge has a stable ID, count, completeness flag and at most five
sample evidence locations. `evidenceFor=edge.id` performs an independent
keyset scan under the same grouping, scope, relation and snapshot. It returns
`dependencyEvidence` with unique declaration locations and real source/target
IDs. `edgeLimit` bounds that evidence page. The returned evidence is not
silently truncated to the five preview locations. Replaying a cursor returns
the same evidence page. Raw SDK edge IDs can differ for duplicate bindings;
the first canonical occurrence supplies the representative evidence ID.

## Verified source anchors and extraction limits

Import declaration anchors come from the source file **only after** its bytes
match the SDK `files.content_hash`. Reading is bounded to 2 MiB total per
request, with a request-local path cache. Exhausting the cumulative read budget
returns `source_scan_budget` and a continuation; an individual oversize or
unreadable source remains incomplete with a warning. Root-relative realpath
checks occur before opening and again after opening; no-follow descriptors,
file identity checks and post-read size/mtime checks protect the same source
boundary as graph-source. A hash mismatch returns `version_expired` and clears
the result instead of mixing current source with indexed edges.

The lexical anchor reader recognizes static ES import declarations and named
or star `export ... from` declarations, including multiline clauses, comments,
quoted strings, escaped quotes and semicolon-free declarations. It only
normalizes locations for SDK relationships; it does not resolve imports or
invent edges. Dynamic import, CommonJS require and import-equals syntax are
outside this verified anchor grammar. If the SDK supplies an imports edge
whose anchor cannot be verified, the edge is omitted from exact counts and
the response is explicitly incomplete (`unverified_import_sites`). Unsupported
languages are also explicit, not a successful empty result.

Unresolved references use the verified declaration's module specifier, so
indentation and multiple statements on one line do not change classification.
Only known Node builtin specifiers are provably external without consulting
unversioned package configuration. Other bare specifiers may be packages or
path aliases; they are honestly marked unresolved. A named binding that is
unresolved inside an already resolved import remains an unresolved diagnostic,
not a second dependency on a fabricated module. External/unresolved groups
never have a target source node ID or pretend to be indexed internal modules.

**Completeness is about scanning the indexed data, not static-analysis
completeness.** The real SDK test demonstrates that this installed 1.6.2 does
not emit an imports edge for its `export * from` fixture. The adapter must not
synthesize it. Imports responses always include
`sdk_import_extraction_incomplete`; the UI explains that star reexports and
other relationships may be missing. This is why even `aggregation.complete=true`
does not certify that every dependency in source or at runtime is represented.

## Bounded work and continuation

- All data scans use node rowid, edge ID and unresolved-reference ID keysets.
  There is no unbounded GROUP BY, whole-index SDK array call or full graph
  materialization followed by slicing.
- Each request examines at most 2,000 data-row operations, including empty
  seeks, node lookups and source-hash lookup rows. The loop reserves room for
  an edge read, both node lookups and a source-hash lookup.
- Summary defaults are 100 nodes and 300 edges, accepting the shared maximums
  of 500 and 1,500. These bound the cumulative visible summary. Reaching one
  ends that query with explicit truncation and requires a narrower scope or
  a higher permitted limit; it does not claim to have scanned the rest.
- Exact deduplication state is capped at 8,192 site hashes and 8,192 resolved
  import anchor hashes. Serialized cursor state is capped at 1 MiB. A hard
  memory/site cap ends the query with a named truncation reason. The shared
  dispatcher additionally bounds live cursor count and lifetime.
- A scan-budget continuation carries cumulative counts. The response declares
  `aggregation.merge=replace`: replace matching IDs/counts; never sum page
  counts. Input cursor state is cloned, so retry is idempotent. Filters,
  grouping, source-line options, scope, asset and index changes cannot reuse a
  cursor from another query.
- Tarjan SCC runs only over the bounded observed internal module graph.
  Returned cycles contain actual node and edge IDs and are already proven.
  During a partial scan absence of a cycle is not proof of acyclicity.

## Reproducible verification

Run with Node 22 (the installed better-sqlite3 ABI does not match local Node 26):

```sh
cd MemoryKnowledge
/Users/zj/.hermes/node/bin/node node_modules/vitest/vitest.mjs run src/engines/code/structured-aggregation.test.ts src/engines/code/structured-aggregation-sdk.test.ts
/Users/zj/.hermes/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

The deterministic SQLite tests cover count identity, scope/depth/root ownership,
SCC, exact evidence paging/retry, real IDs, source security/change handling,
source/data-row budgets, unsupported grammar/languages and partial counts.
The SDK test creates and removes a real temporary TypeScript repository,
indexes it with installed SDK 1.6.2 and asserts same-line imports, multiline
imports, named reexports, cycles, builtin/external distinction, unknown package
specifiers, source identity and the known star-reexport extraction gap. It
does not mock graph output and leaves no fixed temporary probe file.

Browser mode checks and the separate performance fixture are reviewed by the
parent and their owners; this document does not claim they ran as part of
these two test files.

Unresolved binding diagnostics are cumulative replacements, retained up to the
query edge limit (default 300, maximum 1,500). Overflow explicitly returns
`unresolved_diagnostic_budget`, truncation and `aggregation.complete=false`,
even after the index scan finishes. A continuation never silently discards
earlier diagnostic pages or changes the verified import count.
