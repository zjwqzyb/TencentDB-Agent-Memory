# 部署冒烟与升级实测（模型配置）

Date: 2026-10-27
Branch: `feat/server_team`（工作树，未提交）
Purpose: 证明「构建产物可启动」「旧库可原地升级」「新接口在产物中真实注册」。

## 1. Panel 生产构建启动冒烟

- 命令：`npm run build`（tsc → `dist/`）后 `node dist/index.js`，指向一份临时
  `metadata-instances.json`（单实例 `smoke`），`UI_DIST_DIR` 指向 `web/dist`，
  `KNOWLEDGE_LLM_BINDING_SYNC=false`。
- 结果：

| 检查 | 结果 |
|---|---|
| 启动日志 | `panel listening url=http://127.0.0.1:15190 mode=stateless` |
| `GET /health` | `200 {"status":"ok"}` |
| `GET /api/v1/meta/instances` | 200，返回 `smoke` 实例（不下发 api_key） |
| `GET /`（静态 UI） | `200 text/html` |
| `POST .../extraction/test`（无实例头） | `400 MISSING_INSTANCE_ID` |
| `POST .../extraction/test`（实例+key，内核不可达） | `403 PERMISSION_DENIED`（**路由已注册**） |
| `POST .../extraction/resync-knowledge`（同上） | `403 PERMISSION_DENIED`（**路由已注册**） |
| `POST .../extraction/not-a-real-action` | `404 UNKNOWN_META_ACTION`（对照组，证明上面的 403 不是兜底 404） |

> 过程中发现：若 `dist/` 是旧产物，`resync-knowledge` 会返回 404（动作不在白名单里）。
> 说明上线必须重新构建，不能复用陈旧 `dist/`；组合镜像的 Dockerfile 每次都会 `npm run build`，正常路径无此问题。

## 2. Knowledge 生产构建启动冒烟（全新库）

- `node dist/server.mjs`（`PORT=15191`、临时 `KNOWLEDGE_DB_PATH`）
- `GET /health` → `200 {"status":"ok"}`
- `POST /v3/internal/llm-binding/set`（managed 负载）→ `200`，回显
  `provider/protocol/model/config_id/config_version/fingerprint/snapshot_id`
- `POST /v3/internal/llm-binding/list` → 返回同样元数据，`has_api_key=true`，
  **明文 Key 出现次数 0**

## 3. 旧库原地升级实测

### Core（SQLite）
- 造一个 17 列的旧 `meta_instance_upstream_config`（无 `snapshot_json`），插入一条
  extraction 行（version=7、deepseek、含 draft_json）。
- 用 `SqliteMetadataStore(path).init()` 打开后：
  - 列数 17 → **18**
  - 旧行读回：`version=7`、`base_url`、`api_key`、`model_id` 全保留，
    `draft_json` 长度 127 保留，`snapshot_json=""`（等价「从未启用」）

### Knowledge（SQLite）
- 造一个 7 列的旧 `llm_binding`（旧 schema），插入一条 legacy 行（mode=proxy、有 Key）。
- 启动 `dist/server.mjs` 后：
  - 列数 7 → **16**
  - 旧行保留：`config_source='deployment'`，provider/model/version 为 null，
    `enabled=1`
  - `/v3/internal/llm-binding/list` 返回该行且不含明文 Key

## 4. 未覆盖

- Docker 镜像构建（本机无 docker）——需在构建机执行
  `deploy/panel-knowledge-combined/build.sh`。
- 真实 GLM / DeepSeek / 第三方调用（无凭据）。
- 生产环境部署与线上实例验证。

## 5. 跨服务运行时链路（构建产物 + 真实 HTTP）

拓扑：Panel(`dist/index.js`, :15195) → 模拟 Core(:15193)；Panel → Knowledge(`dist/server.mjs`, :15194)。
KS 预置一条 legacy `mode=proxy / config_source=deployment` binding，`KNOWLEDGE_LLM_BINDING_SYNC=false`（不靠启动对账）。

| 步骤 | 结果 |
|---|---|
| `POST /api/v1/meta/instance-upstream/extraction/enable` | `code=0`、`paused=false`、`active_snapshot=snap_e2e_1` |
| KS `/v3/internal/llm-binding/list`（enable 后） | `config_source=managed`、`config_id=ext-e2e`、`config_version=5`、`provider=deepseek`、`model=deepseek-chat`、`snapshot_id=snap_e2e_1`、`enabled=true`、`has_api_key=true` |
| KS list 中的明文 provider key 出现次数 | **0** |
| `POST .../extraction/disable` | `code=0`、`paused=true`、`enabled=false` |
| KS list（disable 后） | `enabled=false`、`unavailable_reason=paused`，provider/model/version 保留 |
| `POST .../extraction/resync-knowledge` | `code=0`、`status=paused`、`outcome=unavailable` |
| **KS 停机后**再次 `enable` | **`502`** `KNOWLEDGE_SYNC_FAILED: ... (core config snap_e2e_1@5 is active; re-sync the knowledge binding before relying on wiki generation)` |

最后一行验证了「KS 同步失败时启用不报告成功」这条验收在真实进程间成立，而不是只在 mock 里成立。

## 6. 发布门禁一键执行

`./deploy/run-release-gates.sh`（新增）真实执行结果：

| 步骤 | 结果 |
|---|---|
| MemoryCore vitest | 10 文件 / 84 项通过 |
| MemoryCore build:plugin | 通过 |
| MemoryProxy vitest | 1 文件 / 14 项通过 |
| MemoryKnowledge vitest | 22 文件 / 155 项通过 |
| MemoryKnowledge build | 通过 |
| MemoryPanel vitest | 11 文件 / 219 项通过 |
| MemoryPanel typecheck / build / web build | 全部通过 |
| dist 产物校验（6 项） | 全部通过（含 resync/test 动作、探针路由、探针模块、KS binding store） |

`SKIP_TESTS=1 ./deploy/run-release-gates.sh` 也验证通过（只构建 + 产物校验），
可在构建机重复执行。

同轮修掉一个真实部署缺口：`deploy/global-images/start-memory-hub.sh` 原先没有把
`PANEL_MODEL_TEST_ALLOW_LOOPBACK` / `PANEL_MODEL_TEST_TIMEOUT_MS` 透传进容器，
运维在 `.env` 里配置也不会生效；已补 `-e` 透传（默认 `false` / `20000`）并写入
`deploy/global-images/.env.example`。

## 7. CI 合并门禁对齐（.github/workflows/pr-ci.yml）

仓库确有 PR CI，其中与本特性相关的是 `pack` / `size` / `isolation` 三个 job。
本地逐项复现后发现并修复了一个**既有**断点：

- `MemoryCore/package.json` 的 `build:scripts` 串联 `build:seed-v2`，目标
  `scripts/seed-v2/tsconfig.json` 在 HEAD 就不存在 → `npm run build` 与
  `npm pack` 失败（对所有 PR 都是红的）。
- 最小修复：从 `build:scripts` 移除该步（保留 `build:seed-v2` 与 `seed-v2` 脚本）。

修复后本地实测：

| CI job | 本地复现结果 |
|---|---|
| pack (`npm pack --dry-run` + `npm pack`) | 通过，405 files / 6.5 MB unpacked |
| size guard | **1655 KB / 2048 KB**，通过 |
| manifest | `id=memory-tencentdb`、`configSchema` 14 props、`pluginApi>=2026.3.13` |
| isolation (`MODE=working-tree`) | PASS（未触碰红线文件、skill 未直接 import fs） |

以上三项已并入 `deploy/run-release-gates.sh`，全量执行全绿。

## 8. 真实 Core 网关端到端（非模拟）

用仓库自带 `MemoryCore/scripts/start-e2e-gateway.ts`（真实 `TdaiGateway` + 真实 SQLite
store + 真实 v3 路由，临时数据目录）跑完整生命周期，**16/16 通过**：

| 断言 | 结果 |
|---|---|
| 草稿创建不激活（`configured=false`） | PASS（version=1） |
| 无证据启用 → `409 TEST_REQUIRED` | PASS |
| 内部 `test-result` 落证据（Bearer-only） | PASS |
| 公开 `get` 返回 `test.matches_current=true` | PASS |
| **写证据不递增 version** | PASS（仍为 1） |
| 伪造 `test_id` → `409 TEST_STALE` | PASS |
| 正确 `test_id` 启用成功 | PASS |
| 生成 active 快照 `snap_...@2` | PASS |
| 公开 DTO 不含明文 Key | PASS |
| 内部 resolver = `ready`，含 service-to-service 凭据 | PASS |
| 停用 → `paused=true`、草稿保留 | PASS |
| 停用后 resolver = `paused` | PASS |
| 过期 `expected_version` → 409 且 data 含 `{expected, actual}` | PASS |

## 9. Core 部署形态澄清

`MemoryCore/dist/index.mjs` 是**插件 bundle**（不含 gateway/metadata 路由）；
`MemoryCore/Dockerfile` 的 `CMD` 是 `node --import tsx src/gateway/server.ts`，
即网关按源码运行，新增的 metadata 路由随镜像内的 `src/` 一起发布。
因此 Core 侧不需要额外的路由产物校验，`build:plugin` 覆盖的是插件运行时
（其中已确认包含 `MODEL_SNAPSHOT_PAUSED` / `resolveActiveModelSnapshot`）。

## 10. 完整真实栈联调（Panel → Core → Knowledge）

拓扑：Panel(`dist/index.js`:15195) → 真实 Core 网关（`scripts/start-e2e-gateway.ts`:15197，真实 SQLite）
→ 真实 Knowledge(`dist/server.mjs`:15194)；LLM 侧用本地 OpenAI 兼容 fixture(:15199)。
Core 按生产姿态运行：Bearer 关闭、实例 `api_key` = admin user_key。

**12/12 断言通过**：

| 断言 | 结果 |
|---|---|
| Panel 在真实 Core 建草稿（不激活） | PASS（v1） |
| 连接测试流式返回 3 条结果 | PASS |
| 三项能力全部通过（basic/json/tools，真实探测 fixture） | PASS |
| 返回 `test_id` + `sha256:` 指纹 | PASS |
| Core 落证据且 `matches_current=true` | PASS |
| `enable` 端到端成功 | PASS |
| Core 生成 active 快照 `snap_…@2` | PASS |
| KS binding 变 `managed` | PASS |
| KS 携 provider/model/version（deepseek/probe-model@2） | PASS |
| KS `has_api_key=true` 且 list 不含明文 Key | PASS |
| `disable` 端到端成功 | PASS |
| KS 变 `enabled=false / unavailable_reason=paused` | PASS |

中途失败一次（`user/create unauthorized`），原因是把 gateway Bearer 当成了实例 `api_key`。
按生产姿态（Bearer 留空、实例 api_key 用 admin user_key）重跑即全绿；该前置条件已写入手册 §3.1。

## 11. 真实浏览器 × 真实三服务（最终 UI 证据）

用 Playwright 打开**真实 Panel**（`dist` + 真实 Core 网关 + 真实 Knowledge，LLM 用本地兼容 fixture），
以真实 admin user_key 登录后完整走一遍界面，**9/9 断言通过**：

| 断言 | 结果 |
|---|---|
| 展示真实实例名（Real Stack Instance） | PASS |
| 连接能力测试区可见 | PASS |
| 草稿写入真实 Core | PASS |
| 真实探测返回三项「通过」 | PASS |
| 展示来自真实 Core 的 `test_id` | PASS |
| 通过测试后解锁「启用配置」 | PASS |
| 启用成功（真实 Core 快照 + 真实 KS 绑定） | PASS |
| 受管配置出现「重新同步知识服务」 | PASS |
| 停用成功（真实 Core paused + 真实 KS paused） | PASS |

截图：`output/playwright/model-config-real-stack.png`（真实实例、`面板管理` 来源、`已启用`、
DeepSeek / probe-model / v2、`密钥已配置`、`重新同步知识服务`、`停用配置`）。

说明：先前所有浏览器验收都是 mock 响应；本节是唯一一次「浏览器 → 真实后端链路」的端到端验证。

## 12. 启动对账（真实 Core + 真实 KS，两个方向）

场景 A：Core 为 **paused**（曾启用后停用），KS 无任何 binding。
启动 Panel（`KNOWLEDGE_LLM_BINDING_SYNC=true`）后：

```json
{ "enabled": false, "config_source": "managed", "unavailable_reason": "paused" }
```
日志：`knowledge model binding marked unavailable (fail closed) … reason=paused outcome=unavailable`
→ 没有把停用状态强行改成 enabled，也没有回退到旧/全局模型。

场景 B：在 Core 里重新启用（version 4），再次重启 Panel 后：

```json
{ "enabled": true, "config_source": "managed", "config_version": 4,
  "provider": "deepseek", "protocol": "openai", "model": "deepseek-chat",
  "snapshot_id": "snap_01M5XGKC3WFE4K66FQWGEAZV84", "has_api_key": true,
  "proxy_base_url": "http://127.0.0.1:8096" }
```
日志：真实 `POST /v3/meta/user/create`（铸造 `knowledge-service` 用户成功，响应中的
`default_user_key` 在日志里被掩码为 `sk-mem-m…`），随后
`knowledge model binding synced from active snapshot … outcome=bound`。

这两条覆盖了「启动恢复不得强制 enabled / 重启后与 Core 一致或明确不可用」的验收项，
且是**真实服务**而非 mock。

## 13. MemoryProxy 启动冒烟

`node --import tsx src/index.ts --config <config.example.yaml 副本>`（端口改 15203）：

- 配置解析成功，识别全部 26 个段（含 `instanceUpstream`、`extraction`、`systemUsers`）
- `server.listening {"port":15203}`，请求 `/` 返回 502（上游不可达，符合预期）
- `systemUser.init {"count":1}`、`auth.init`、`storage: sqlite`、`injection: Redis` 均按配置生效
- 无人为侵入；Redis/上游不可达只产生连接告警，进程保持运行

说明：本项只证明**我们改动后 Proxy 仍能正常启动并服务**。
写侧 fail-closed 门禁的判定逻辑由 `MemoryProxy/src/__tests__/extraction-gate.test.ts` 的 14 项
单测覆盖（含 paused / incomplete / unavailable / 读取失败 / 1h TTL 下即时生效）；
端到端的 systemUser 运行时链路需要真实 Core + 认证用户，未在本轮执行（NOT_RUN）。
