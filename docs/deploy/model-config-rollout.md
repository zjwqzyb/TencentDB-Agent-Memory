# 模型配置上线手册（Memhub 实例级模型配置）

适用版本：`feat/server_team` 上「设置 → 模型配置」全套能力（草稿 / 连接能力测试 /
启用 / 停用 / 运行时快照）。涉及 MemoryCore、MemoryPanel、MemoryKnowledge、
MemoryProxy 四个服务。

## 1. 这次上线改变了什么

| 层 | 行为 |
|---|---|
| 界面 | 设置弹窗新增「模型配置」页签（仅 `system_admin`）；草稿保存、三项连接能力测试、启用/停用 |
| Core | extraction 行新增 `snapshot_json`（active 快照 + 最近一次测试证据）；`enable/disable` 走测试门禁与 `expected_version` 乐观锁 |
| 运行时 | L1/L2/L3/Skill/Wiki 在**作业开始**解析一次 active 快照，作业内固定版本；`paused`/`invalid`/读取失败一律 fail-closed |
| Knowledge | `llm_binding` 新增 provider/model/protocol/config_source/config_id/config_version/fingerprint/snapshot_id/unavailable_reason；启用/停用后与 Core 对账 |
| Proxy | extraction 门禁同时校验 `enabled + endpoint + key + model`；systemUser 请求强制刷新，1h TTL 下仍即时生效 |

**四个服务必须同批次升级**：Core 新增内部接口（`/v3/internal/meta/instance-upstream/extraction/snapshot`、
`.../test-result`），Panel 依赖它们做测试证据落库与 KS 同步。只升级 Core 时，旧版 Panel 仍然只能调用
`extraction/toggle`，该路径现在会返回 `TEST_REQUIRED`（启用必须带 `test_id`），也就是说新旧混搭下
「启用」会明确失败而不是静默生效。

## 2. 数据库迁移（自动）

- **Core（SQLite）**：启动时 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN snapshot_json`，
  幂等；既有行取默认空串，等价于「从未启用受管配置」。
- **Core（MongoDB）**：新字段随文档写入；旧文档缺 `snapshot_json` 时按空处理，读取路径兼容。
- **Knowledge（SQLite）**：`llm_binding` 新增列由 `addColumnIfMissing` 幂等补齐，旧行默认
  `config_source='deployment'`（保持老部署行为）。
- **不需要手工 DDL**，也不需要重建历史知识。回滚版本时新增列会被旧代码忽略。

已在真实旧库上实测升级（不是只看代码）：

| 库 | 升级前 | 升级后 | 说明 |
|---|---|---|---|
| Core `meta_instance_upstream_config` | 17 列 | 18 列（+`snapshot_json`） | 旧 extraction 行 `version/base_url/api_key/model_id/draft_json` 全部保留，`snapshot_json` 为空串 = 从未启用 |
| Knowledge `llm_binding` | 7 列 | 16 列（+9 列） | 旧行保留，`config_source='deployment'`，`/list` 仍不返回明文 Key |

## 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PANEL_MODEL_TEST_TIMEOUT_MS` | `20000` | 单条能力（基础/JSON/工具）超时 |
| `PANEL_MODEL_TEST_ALLOW_LOOPBACK` | `false` | **生产必须保持 false**。只允许 https 公网端点；仅本地 fixture 才开启 http/loopback |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `true` | 开启后 Panel 启动会与 Core active snapshot 对账并推送到 KS；关闭则只有 enable/disable 时同步 |

其余沿用既有配置；本次**没有新增必填项**。

## 3.1 部署前置：实例凭据姿态（真实链路实测发现）

在真实栈联调中，`enable` 触发 KS 代理凭据铸造（`user/list` → `user/create` → `user-key/create`），
用的是 **Panel 实例配置里的 `api_key`** 作为服务身份。因此：

- `metadata-instances.json` 里的 `api_key` **必须是该实例的 admin user_key**，不能只填 gateway Bearer；
  否则 `enable` 会返回 `502 KNOWLEDGE_SYNC_FAILED: user/create failed: unauthorized`。
- `MEMORY_CORE_GATEWAY_API_KEY` 保持为空（`deploy/global-images/start-memory-core.sh` 的默认），
  因为 Proxy 调 `/v3/meta/auth/verify` 时不带 Bearer；Core 在 Bearer 为空时按「关闭鉴权」处理。
- 若 KS 里已经有可用的 proxy binding（`has_api_key=true` 且 `proxy_base_url` 未变），Panel 会复用旧凭据、
  不再铸新号 —— 存量实例升级通常走这条路径。

这一点与 `start-combined.sh` 的注释一致（`REMOTE_INSTANCE_KEY` 写的是「local or admin gateway key」），
但值得在配置时显式确认，否则表现为「启用失败但草稿与测试都正常」。

## 4. 部署顺序（建议）

1. **MemoryCore**：升级并重启。确认 `snapshot_json` 列已补齐（SQLite 可直接 `PRAGMA table_info`）。
2. **MemoryKnowledge**：升级并重启（新列迁移在启动时完成）。
3. **MemoryPanel**：升级并重启。启动对账会为每个实例把 Core 的 active snapshot（或 paused/invalid）
   同步到 KS。
4. **MemoryProxy**（如启用）：升级并重启，使 extraction 门禁与禁用即时生效。

Panel 与 Knowledge 的顺序不能反：Panel 启动对账要调用 KS 的 `/v3/internal/llm-binding/*`。

## 5. 上线自检（必须逐条走完）

0. **脚本预检**（先确认接口通、状态符合预期）：

   ```bash
   deploy/verify-model-config.sh \
     --panel-url http://<panel>:8125 \
     --instance-id <instance> \
     --user-key <system_admin 的 user_key> \
     --expect deployment        # 首次上线前应为 deployment；启用后改为 active/paused
   ```

   退出码：`0` 正常；`1` 网络/鉴权/信封错误；`3` 状态与 `--expect` 不符。
   加 `--resync` 可顺带触发一次「重新同步知识服务」。

1. 用 `system_admin` 登录 → 设置 → **模型配置**，确认能看到实例名、适用范围、来源与状态。
2. 填供应商/Base URL/模型 ID/Key → **创建草稿** → 出现「测试连接」。
3. **测试连接**：基础调用、JSON 输出、工具调用三项都应「通过」；任一项失败会给出错误码
   （`AUTH_FAILED` / `MODEL_NOT_FOUND` / `RATE_LIMITED` / `TIMEOUT` / `TOOL_CALL_UNSUPPORTED` …）。
4. **启用配置**：状态变「已启用」，启用请求带 `expected_version` 与 `test_id`。
5. 触发一次真实作业（L1 抽取 / Skill / Wiki），在日志里核对 `config_id`、`version`、`provider`、
   `model`、脱敏 endpoint 与 outcome；全局 upstream 不应收到该作业的请求。
6. **停用配置**：状态变「已停用（受管配置）」，KS binding 变为 `enabled:false`；新作业明确失败，
   不回退部署模型。
7. 用普通账号确认看不到该页签，直调接口返回 403。

自动化发布门禁（发版前必跑，一条命令覆盖四模块测试/构建 + 产物校验）：

```bash
./deploy/run-release-gates.sh
# 只重跑构建与产物校验（跳过测试）：
SKIP_TESTS=1 ./deploy/run-release-gates.sh
```

门禁内容：
- MemoryCore（vitest + build:plugin）、MemoryProxy（vitest）、
  MemoryKnowledge（vitest + build）、MemoryPanel（vitest + tsc + build + web build）
- **CI 对等门禁**：`check-skill-queue-isolation.sh`（红线文件/直接 fs 引用）+ `npm pack` 与 2048 KB 体积上限
- 产物校验：`dist/` 中必须含本特性的路由/动作/模块字符串（防「复用旧 dist 上线」）

## 5.1 网关 / 反向代理约束（必须核对）

- 「测试连接」是 **NDJSON 流式响应**（`content-type: application/x-ndjson`，服务端已回
  `X-Accel-Buffering: no`）。如果前置 nginx 开着 `proxy_buffering`，需要对该路径关闭，
  否则前端要等三条能力全部跑完才一次性显示：

  ```nginx
  location /api/v1/meta/instance-upstream/extraction/test {
      proxy_buffering off;
      proxy_read_timeout 90s;
  }
  ```

- 单条能力默认 20s（`PANEL_MODEL_TEST_TIMEOUT_MS`），三条顺序执行最坏约 60s。网关
  `proxy_read_timeout` / SLB 空闲超时建议 **≥ 90s**，否则流会被中断。
- `extraction/enable|disable|resync-knowledge` 是普通 JSON 请求，30s 足够；但
  `enable` 会同步推送 KS，KS 不可达时要等 `KNOWLEDGE_TIMEOUT_MS`（默认 30s），
  网关对这三个路径的超时建议 ≥ 45s。
- Panel 侧 `PANEL_MODEL_TEST_ALLOW_LOOPBACK` 在生产必须为 `false`，否则管理员可以把实例
  当作内网探测跳板。

## 5.2 顺带修复的既有问题

- `MemoryCore/package.json` 的 `build:scripts` 原先串联 `build:seed-v2`，指向
  `scripts/seed-v2/tsconfig.json`，而该目录在 HEAD 就不存在（仅保留了已构建的
  `bin/seed-v2.mjs`）。这会让 `npm run build` 与 CI 的 `npm pack` 对所有 PR 失败。
  已从 `build:scripts` 移除该步（`build:seed-v2` 脚本本身保留，源码回归可再挂回）。
- `MemoryProxy` 的 `tsc --noEmit` 有 1 条既有报错（可选子模块
  `@context-proxy/cost-guard` 未包含在仓库），运行时走 fallback，与本特性无关。

## 6. 回滚

1. 首选**停用受管配置**（不删草稿、不删快照）：后台生成立即 fail-closed，配置可随时再启用。
2. 需要整体回滚版本时，按 **Panel → Knowledge → Core** 的逆序回退；新增列/字段对旧版本透明。
3. 不要手工删除 `draft_json` / `snapshot_json`，也不要手工改 KS binding —— 让 Restart 后的对账收敛。
4. 回滚后如仍需旧行为（部署默认模型），必须先停用受管配置；仅回退版本而保留 active 快照时，
   旧版 Core 仍会把它当成生效配置。

## 7. 已知限制与排障

- **enable 成功但 KS 同步失败**：返回 `502 KNOWLEDGE_SYNC_FAILED`，此时 Core 已启用、重试 enable 会 409。
  恢复方式：在「模型配置」里点 **重新同步知识服务**（`POST /api/v1/meta/instance-upstream/extraction/resync-knowledge`，
  仅 system_admin），或重启 Panel 触发启动对账。该动作只重读 Core 快照并推 KS，不写 Core 配置。
- **Proxy 计量**：实例存在 active 快照时 Core 直连该 endpoint（即使部署配了 `llm.provider=proxy`），
  以保证「每个作业一个固定快照」；代价是这几个作业不再经 Proxy 计量，Proxy 侧门禁仅作为防线。
- **测试地址限制**：生产只允许 https；http/loopback 需要显式打开 `PANEL_MODEL_TEST_ALLOW_LOOPBACK`，
  不要在生产打开。
- **MemoryProxy typecheck**：`src/storage/factory.ts` 引用可选子模块 `@context-proxy/cost-guard`，
  仓库未包含该 workspace 包时 `tsc --noEmit` 有一条既有报错，与本次改动无关（运行时走 fallback）。

## 8. 证据索引

- `output/playwright/model-config-acceptance.md` —— 设置页 / 草稿 / 密钥 / 冲突 / 窄屏（25 项浏览器断言）
- `output/playwright/model-config-test-acceptance.md` —— 连接能力测试（31 项）
- `output/playwright/model-config-snapshot-acceptance.md` —— 测试门禁 / 启用 / 停用 / 快照（23 项）
- `output/playwright/model-config-runtime-acceptance.md` —— L1/L2/L3/Skill/Wiki 运行时消费与各子项目测试数
- `output/playwright/model-config-deploy-smoke.md` —— 构建产物启动冒烟、旧库升级实测、Panel→KS 跨服务运行时链路
- `deploy/run-release-gates.sh` —— 四模块发布门禁（测试/构建/产物校验），可交给构建机直接执行
