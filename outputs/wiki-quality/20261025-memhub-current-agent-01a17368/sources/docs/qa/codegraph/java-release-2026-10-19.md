# Java CodeGraph release — 2026-10-19

The Java CodeGraph adapter and canvas DPR fix are deployed and accepted. The final running Hub image is `sha256:746a87484d7722510f0f99e9229f5da89e4405e76c0037fc4a98fbec695a8806`.

The Java relation adapter and recovery UI were independently committed and pushed as `39a53d24aac32fda77fa2f67fd9d024e25a299ec` on `feat/server_team`. The commit contains exactly the 22 approved paths. The Java feature image was `sha256:ee5e1623ad37d96f56ef3bd93b3db658b1f6a0a656ece6e2543bf28ef4c8a250`, derived from the existing production Hub image `sha256:d1c93f2626553683912ed56c34012af4acfc0890ba7b1419fc3dd28382abce0f`.

## Preserved production behavior

The source build used the clean commit plus the same 14 audited task UI, Panel, Wiki, and enterprise Git overlays as the prior release. Each overlay hash matched the saved baseline. Only Knowledge and Web compiled output is replaced; Panel runtime output and the existing Node/SDK runtime dependencies are inherited from the production image. Core and Proxy are outside this release. No indexing or synchronization command was run.

## Completed candidate checks

- Clean build with Node 22.23.0: Knowledge typecheck/build, Panel build and Web build passed; Knowledge structured tests 92/92 and Panel model/API/real-chain tests 127/127 passed.
- Candidate health: healthy with network disabled, a read-only root filesystem, fresh temporary storage and no production mounts or environment values. Panel and Knowledge health checks both succeeded.
- Real Java index: 103,502 nodes and 194,125 edges. A read-only SQLite backup preserved committed WAL data; all 4,517 copied code files matched their indexed SHA-256 hashes. No source copy failed.
- Java: 12 isolated checks passed on Node 22.23.3 / SDK 1.6.2. Namespace selections gave accurate empty states; `DefaultCodeGenerator.process` retained all four calls, including across 2-node/1-edge pages; class and interface inheritance, same-version source and directed impact evidence passed. The incorrect `log.info` target and heuristic interface dispatch were omitted.
- Java dependency and cluster samples exposed real import declarations and same-version source. The first observed aggregate relations required 102 bounded pages; every query stayed within 2,000 database rows and its node/edge limits. Results remained marked truncated; these checks do not claim a complete repository scan.
- TypeScript baseline: six isolated checks passed, including the existing 23-node/31-edge call graph, 2-node/1-edge hierarchy, 9-node/16-edge impact graph, source and aggregate evidence.

The final standalone verification adapter was rebuilt from the committed source; its SHA-256 is `9cda3b4fbbe2d45ba7b22901a7f21da913af45a9dc240580b065049d170694d8`. It was run directly in one-shot containers against read-only isolated snapshots, without importing the service startup modules.

## Production operation checks

The Java Hub first switched at `2026-10-19T04:45:59.653878462Z`. The final Web-only canvas image `sha256:746a87484d7722510f0f99e9229f5da89e4405e76c0037fc4a98fbec695a8806` switched at `2026-10-19T05:08:11.379250939Z` and is healthy. Panel and Knowledge returned `status: ok`. All 21 files in the Java image matched the audited build; after the canvas follow-up, all eight final Web/manifest files also matched the new audited SHA-256 values. The runtime remains Node 22.23.3 / SDK 1.6.2. The Hub environment matches the protected backup, and its two volume bindings match the baseline exactly: the existing Knowledge data directory remains writable and `metadata-instances.json` remains read-only.

Core stayed healthy on image `sha256:7ce6338db1e3b8575d660e259130bb522362e3e19f30f1f228449a9a8b4c0cd3` with the unchanged start time `2026-10-18T15:45:14.184798694Z`. No Core or Proxy restart was performed.

The first deployment attempt stopped before changing the image config or renaming/stopping Hub because the host lacked Python3. The prior Hub stayed healthy. The corrected script uses verified host awk/chmod/mv commands and a new release directory, `/opt/tencent-agent-memory/releases/codegraph-java-final-20261019`; the first attempt's log, backups and records remain preserved in the original `codegraph-java-20261019` directory.

## Parent production acceptance

The parent independently passed nine real Java API checks on the production service: accurate namespace guidance, four process calls and matching source, class/interface inheritance, incorrect log target omission, directed impact, and real dependency/cluster imports. The original Java index version remains `71afa6ffd985e14abb61f873a34e5d9a`. Dependencies and clusters each reached their first observed relations after 102 pages and still reported truncation.

The parent also passed the complete serial TypeScript production regression. Calls remained 23 nodes/31 edges; both aggregate modes accumulated 11 nodes/4 real edges over 60 pages while still reporting truncation. An earlier concurrent Java/TypeScript pagination failure is consistent with the 128-entry cursor cache evicting an older cursor; the original report did not retain the specific warning, so this cause remains an inference. Serial re-verification passed on the same index, and the earlier report is preserved separately.

Authenticated production browser checks passed against real data without mocks: Java capability label, process 5/4 and four source locations, namespace selection guidance and search recovery, hierarchy 5/4 including HttpBaseOperator plus three implementors, dependencies 15/14, clusters 3/3, and impact 2/1 focused on before, with a process → before evidence path. Both aggregate samples remain truncated.

## Canvas DPR follow-up

The parent found a Sigma 3.0.3 canvas alignment defect when DPR changed from 2 to 1 without a CSS size change: the old GL backing store could remain in use while arrows/labels used the new pixel scale. The focused fix and browser regression were independently committed as `c9f6645f1e8231c2fe37609c3ff6577ffb397630`, containing exactly two approved files. The parent independently passed 114 checks, including actual blue GL pixel locations, backing sizes, viewport, labels, relation endpoints and DPR transitions. CDP changes DPR without dispatching OS media notifications: the listener-path test explicitly dispatches a media-query change event, while the missed-event path is checked through fit. The checks do not cover OS notification delivery from physically moving between monitors.

A Web-only candidate, `sha256:746a87484d7722510f0f99e9229f5da89e4405e76c0037fc4a98fbec695a8806`, was built from that clean commit plus the same overlays, using the deployed Java image as its base. All 436 inherited Knowledge/Panel output files, package manifests and Node binary hashes match the Java image. The isolated candidate passed health checks and its temporary health container was removed after verification. The Web-only image is now deployed and healthy. Core container ID, image and start time remain unchanged; environment and mounts match the baseline. The parent loaded the final production `main-vBIlMdwD.js`, changed DPR 2→1 through CDP and used ordinary fit: backing dimensions matched the GL viewport at both DPRs and the Java graph remained 5 nodes/4 edges. The parent visually confirmed that nodes, arrows and labels align. Final API spot checks passed the unchanged Java index, same-snapshot source and TypeScript 23-node/31-edge calls. No API mocks were used. The machine-readable companion is [java-release-2026-10-19.json](java-release-2026-10-19.json); build, source, artifact and candidate evidence is under `output/deployment/codegraph-java-20261019/` and `output/deployment/codegraph-canvasfix-20261019/`.

## Java support boundary

The graph displays SDK-extracted static relations that pass adapter validation. Heuristic dispatch, unverifiable targets and some dynamic, reflection or wildcard-related calls are omitted. Java support does not promise complete language semantics or complete runtime impact. Impact uses calls, imports, extends, implements and references; it excludes `instantiates`. Directory clustering remains path grouping. Existing TypeScript/JavaScript behavior and its documented extraction limits are preserved.

## Rollback

The final release-scoped script is `/opt/tencent-agent-memory/releases/codegraph-canvasfix-20261019/ops/rollback-codegraph-canvasfix.sh`. It restores the retained prior Hub and the matching `images.env`; it does not overwrite the existing start/restart scripts. The previous Java Hub is retained as `tdai-memory-hub-rollback-canvasfix-20261019-130810` with image `sha256:ee5e1623ad37d96f56ef3bd93b3db658b1f6a0a656ece6e2543bf28ef4c8a250`; reverting this Web follow-up keeps the Java adapter. All health requests have a five-second timeout.

No credentials, cookies, keys or environment values are included in this report.
