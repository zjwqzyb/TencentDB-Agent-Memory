# CodeGraph impact and type hierarchy

Status: backend implemented and verified, ready for independent acceptance. UI and tracker completion are owned by the parent reviewer. This extends the structured API decision from the same date; it does not claim cluster mode is implemented.

## Bounded mode boundary

`structured.ts` owns authorization-adjacent input validation, immutable snapshot cursors, transaction lifecycle, budgets and response completion. `structured-mode-context.ts` exposes counted primary-key scans, indexed adjacency and indexed unresolved lookups to mode modules. Impact and hierarchy live in `structured-neighborhood.ts`; dependency aggregation lives in its own module. All wire fields remain in the canonical contract and generated self-contained copies.

Mode defaults are part of normalized cursor identity. Impact defaults to incoming, depth two and calls/imports/extends/implements/references. Hierarchy defaults to both directions, depth one and extends/implements. Explicit equivalent defaults and reordered filters reuse the same cursor; changed mode/depth/filter/snapshot does not. Neither mode propagates `contains`. Defaults are 100 nodes and 300 edges per response, 500/1500 cumulative traversal, five hops and 2,000 counted row operations per request.

Schema gates verify actual leading index columns rather than index names alone: source+kind and target+kind adjacency, plus from_node_id for unresolved references. Required primary keys are verified as well. A primary schema mismatch disables all modes. Missing or misleading unresolved indexes produce coverage warnings and no unbounded fallback.

## Potential impact

Traversal follows incoming edges but returns their actual source → target direction. `nodes.depth` is the shortest distance from the changed symbol in this reverse traversal. `impactPaths` stores an evidence path from the affected node back to the focus using real node IDs and edge IDs; it never invents an explanatory edge. At least one shortest path is retained per affected node. Additional real graph edges, cycles and distinct parallel edges remain visible.

Pages can reference nodes and path edges returned by earlier pages. The client must merge pages by ID before interpreting the paths. Tests verify every path node and edge exists in the complete merged response and has the stated direction, including tiny two-node/one-edge pages. This is potential static impact; warnings explicitly disclose unresolved and dynamic relationships. It does not establish runtime reachability, test coverage or an exhaustive set of affected files.

## Verified hierarchy capability and limitation

Real temporary SDK 1.6.2 TypeScript/JavaScript indexes verify class extends, TypeScript class implements multiple interfaces, JavaScript class extends, and incoming interface implementations. Edges retain child → base and class → implemented interface direction. Non-type focus returns `select_a_type`. Indexed unresolved bases/interfaces are returned separately with names and locations, never synthesized into resolved graph edges or source-bearing nodes.

**SDK 1.6.2 does not extract TypeScript interface extends in the tested fixtures.** Interface diamonds in source therefore cannot be presented as supported extraction. Hierarchy capability lists `typescript_interface_extends_not_extracted`, and hierarchy responses carry the same warning. Outgoing interface queries return unsupported. Incoming implements remains useful; a both-direction interface query with real inbound edges returns those edges with the coverage warning. A both-direction interface query without real edges is unsupported rather than proof of no relations.

The synthetic diamond test verifies only bounded traversal topology and all-parent edge retention. It is deliberately separate from real SDK extraction tests. No alternative parser or fabricated hierarchy was added to hide this gap.

## Evidence lines in long source files

`graph-source` accepts optional positive integer `sourceLine`, exclusively for that endpoint. It selects a window starting up to 50 lines before that evidence line, returning at most 300 lines from the node's same indexed file. It does not accept a path. Node ownership, asset/version binding, realpath/descriptor checks, 2 MiB file bound and indexed SHA-256 checks apply unchanged.

Malformed numeric values, zero/negative/fractional lines and values beyond the byte-derived maximum are rejected as HTTP 400. A positive line beyond the actual verified file returns `source_unavailable` with `source_line_out_of_range`; it is never silently clamped. Without `sourceLine`, existing node-range behavior remains. The real SDK → Knowledge HTTP → Panel integration fixture verifies an import at line 1000 and exact returned source text.

## Validation and reproducible backend measurements

`structured-neighborhood-sdk.test.ts` uses the real SDK for all five impact relation directions, multiple hops, source verification and the hierarchy capability/limitation cases. `structured-neighborhood.test.ts` uses controlled SQLite topologies for pagination, shortest paths, cycles, caps, default normalization and hostile index schemas. Existing calls and route tests remain part of regression checks. Panel real-chain and ACL tests cover the shared contract and evidence-line forwarding.

`structured-performance.test.ts` constructs an actual SQLite database with 5,000 nodes and 15,000 edges. Its topology is synthetic, not evidence of parser completeness. It records the first mode query, five warmups, and 30 unsorted raw timing samples per mode. The dependency sample is an immutable continuation in the imports edge phase, after node scanning and the first 9,000 non-import edges; assertions require actual import counts to increase. Files and indexed hashes are present for declaration verification. Counts and work budgets are asserted on every timed result.

The measurement includes opening a read-only connection, schema validation, bounded SQL and response object construction. It excludes JSON encoding, HTTP transport and browser rendering. “Cold” means the first query of a mode in that process; OS filesystem caches are not flushed. Backend measurements cannot establish interactive/browser acceptance.

The raw report is saved alongside QA evidence. On Apple M1, 8 logical CPUs, 16 GiB, macOS Darwin 25.6.0 arm64 and Node 22.23.0, the parent reviewer's final five-mode acceptance run recorded warmed p95 values of calls 5.42 ms, impact 2.74 ms, hierarchy 1.02 ms, dependencies 1,321.20 ms and clusters 74.84 ms; maximum counted rows were 400, 50, 18, 1,996 and 1,996 respectively. This run included concurrent local build load and was retained without selecting faster samples. Timing varies with filesystem/cache load; the raw report records host load and exact samples. All measured p95 values met the 2,000 ms backend target.

```sh
PATH=/Users/zj/.hermes/node/bin:$PATH \
CODEGRAPH_BENCHMARK_REPORT=/tmp/codegraph-backend-performance.json \
CODEGRAPH_BENCHMARK_DATASET=/tmp/codegraph-browser-dataset.json \
MemoryKnowledge/node_modules/.bin/vitest run MemoryKnowledge/src/engines/code/structured-performance.test.ts
```

The optional dataset is an actual 100-node/300-edge response from this database for separate browser experiments. It is not timing evidence and does not replace the real SDK HTTP chain test.
