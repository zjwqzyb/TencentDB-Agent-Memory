# CodeGraph production release — 2026-10-19

## Release outcome

The CodeGraph UI and WAL snapshot fix are deployed to the existing Hub on `192.168.200.137`. The final image was built for `linux/amd64` from feature commit `c8ccf254746374c69b0e8af43ff82d63596a0a8c` with WAL fixes `9f71011df69392ca67a0fbe0c87280f4dffb33cc` and `f77ef249d491eaa5331b36d7348402b2a957a218`. The deployed container image ID is `sha256:d1c93f2626553683912ed56c34012af4acfc0890ba7b1419fc3dd28382abce0f`; deployment evidence records the healthy container and service checks.

The sanitized, machine-readable release summary is [`production-release-2026-10-19.json`](production-release-2026-10-19.json).

The release preserved the existing task workbench and audited production behavior. It reused the existing Knowledge volume and `cg-4oc687yt` index at commit `e9a82935b527` (version 4, 1,025 files, 28,394 nodes, 70,367 edges). No production reindex was run and Core was not restarted. Runtime environment values were compared without recording their contents.

## Release history

The first candidate was briefly switched, then rolled back when read-only graph search repeatedly reported `version_expired` / `index_changed_during_query`. A second candidate stayed isolated; Linux testing showed Node could report a WAL file's `ctime` as `birthtime`, and SQLite changed that metadata while opening the file read-only. The WAL identity was corrected to use device, inode, size, and `mtimeNs` while retaining the main database identity checks. The final Linux smoke passed before the final image was switched.

## Preserved baseline and assets

The final image retained the four task UI source files, Panel issue meta actions, the authenticated Wiki route, and the audited Knowledge production patches listed in the release JSON. It did not include unrelated dirty Core issue-tracker changes. The existing runtime data, environment, and metadata were reused.

Served static assets matched the reviewed local build byte-for-byte:

| Asset | SHA-256 |
| --- | --- |
| `index.html` | `60d861cc733016f82cf9f22ab431c1c25981d0905b0881709462a0cfc6bc27f3` |
| `main-C37_cp_s.js` | `c8193113cd695dffcd0029439fd305d5585a5eacadde040a58b21c602605599f` |
| `main-BrQtKVsl.css` | `bb09685e4bb015d1a0cec224ee206899381c66d1e17101c0b4521b339b328687` |
| `KnowledgeGraph-jCtOX3Uf.js` | `0602c86ee597b6ca6a8cbde9e98787090ae1570d083032fa55428706e40deb72` |
| `KnowledgeGraph-DEqMBSbC.css` | `6505010502bc705ad0a66cfd67294797ae319b8d2e35f3aff3ea7a658c7395b3` |

The CSS digest recorded in the release JSON was corrected after recomputing it from the saved local build; it matches the deployed bytes.

## Validation

- **Health:** Panel and Knowledge returned HTTP 200; the final Hub container was healthy.
- **Linux WAL smoke:** passed cold read, repeated search/cursor, calls/source, committed-write expiry, and empty-WAL cleanup on Node 22.23.3, SQLite 3.49.2, and better-sqlite3 11.10.0.
- **Production API:** all five modes, budgets, same-snapshot source, legacy text search, and real aggregate edges passed. Dependencies and clusters each returned 11 nodes and 4 real edges over 60 pages while correctly retaining `truncated: true`; the report does not claim full-index completion. Details are in the release JSON.
- **Production UI:** passed a read-only review in the authenticated production browser using the real `cg-4oc687yt` index; no mock data, sync, edit, or write action was used. The task workbench rendered. Calls on `createKnowledgeModule` showed 23 nodes and 31 relations with function source visible; impact on `SqliteKnowledgeStore` showed 9 nodes and 16 edges; hierarchy on that class showed 2 nodes and 1 relation with class source visible. Dependencies and clusters each showed a 1-node, 0-edge first page with an explicit truncation notice. The production API continuation checks covered 60 pages in each mode and accumulated 11 nodes and 4 real aggregate edges, while correctly remaining truncated. The relation list showed two real tables, and returning to the canvas worked. High-fan-out views are visually dense; zoom or the relation list can help. Selected screenshots are included under [`production-release-2026-10-19/`](production-release-2026-10-19/) and listed in the JSON evidence.

## Rollback

The prior Hub remains available as the stopped container `tdai-memory-hub-rollback-20261019-112508`. The release-scoped rollback script restores the previous Hub and the matching `images.env`, `start.sh`, and `restart-hub.sh` backups:

```sh
bash /opt/tencent-agent-memory/releases/codegraph-walfix-final-20261019/ops/rollback-codegraph.sh
```

The release changed only the Hub image and removed the four obsolete Hub source mounts whose reviewed behavior is compiled into the image. The Core ACL mount and Core container were left intact. The generic restart script was not invoked. Full operational details and container/image identifiers are in the release JSON.

No credentials, cookies, user keys, or runtime environment values are included in this report or its linked evidence.
