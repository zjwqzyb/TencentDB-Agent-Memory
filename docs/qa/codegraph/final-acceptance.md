# CodeGraph 集成验收记录

记录日期：2026-10-19。父 Agent 已完成代码审核和独立复核，五类视图符合本期关闭条件。实现由三个子 Agent 完成，父 Agent 负责协调、审核、验收与任务状态；本次没有提交、推送或生产发布。

## 证据范围

| 检查层 | 真实执行内容 | 证据边界 |
| --- | --- | --- |
| SDK 语义 | 安装的 SDK 1.6.2 创建临时 TS/JS 索引，断言真实节点、边方向和源码 | 只证明已测试语言及结构，不承诺其他版本/语言 |
| 有界算法 | 实际 SQLite 表和索引，预算、分页、循环、路径和不兼容 schema | 合成拓扑证明算法性质，不冒充解析器支持 |
| 服务链路 | 真实 SDK → Knowledge Hono → 本地随机端口 HTTP → HttpKnowledgeClient → Panel Hono | 资产目录、身份和 ACL 元数据使用测试夹具；图结果和源码来自真实实现 |
| 权限边界 | 每个结构化入口，以及五种 mode 的拒绝授权、缺身份、无团队成员关系、跨 service/asset | 检查拒绝请求未触达图查询服务 |
| 后端性能 | 5,000 节点/15,000 边真实 SQLite 数据库，首次 query、预热与 30 次原始样本 | 不包含 JSON 编码、HTTP 传输或浏览器绘制 |
| 浏览器交互 | 子 Agent 与父 Agent 已完成 mock 边界场景和真实 HTTP 链路独立复核 | mock 与真实链路报告分别标明，不相互冒充 |

`live-browser-server.md` 提供临时真实服务，浏览器只 mock 目录/身份，将所有结构化请求转发到真实 SDK → Knowledge HTTP → Panel HTTP 链路。UI Agent 在 Chrome 155.0.8059.82 完成 15/15 检查，包含全部五模式、graph 13 次/source 9 次真实请求、同一 indexVersion、第 1000 行证据源码和不可变提交链接。结果在 `codegraph-live-result.json`，脚本为 `MemoryPanel/tests/knowledge/browser/code-graph-live.js`，重放生成器为同目录的 `prepare-live-fixture.py`。父 Agent 的独立复核结论留在本文最后一节。

## 后端检查记录

| 检查 | 当前结果 | 文件 |
| --- | --- | --- |
| 调用、自环、平行/反向边、同名消歧 | 通过 | `structured.test.ts`、`structured-sdk.test.ts` |
| 反向潜在影响、五类边、最短距离、跨页完整证据路径 | 通过 | `structured-neighborhood.test.ts`、`structured-neighborhood-sdk.test.ts` |
| 类继承、多接口实现、类型筛选及 unsupported 区分 | 通过，保留接口继承能力缺口 | 同上 |
| 导入声明去重、聚合对账、SCC、外部/未解析证据与源码验证 | 已由父 Agent 验收依赖子任务 | `structured-aggregation.test.ts`、`structured-aggregation-sdk.test.ts` |
| 聚类逐级展开、双向边界与符号级证据 | 通过，包括同声明多目标、distinctSiteCount 跨层对账、symbol SCC/自环和累计诊断预算 | `structured-clusters.test.ts`、`structured-aggregation.test.ts`、`structured-aggregation-sdk.test.ts` |
| 五种模式真实 HTTP 链路 | 通过，包括聚类目录→文件→符号对账、incoming 边界、折叠幂等、跨 mode 游标拒绝和全部 mode 版本拒绝 | `MemoryPanel/tests/knowledge/code-graph-live-chain.test.ts` |
| sourceLine 第 1000 行、非法数值、越界、过期版本 | 通过 | adapter、Panel boundary 与 live-chain 测试 |
| 五种 mode 资产 ACL / 团队 / 服务 / 身份一致性 | 通过；边界套件当前 115/115，包含新增五 mode 共 25 项检查 | `MemoryPanel/tests/knowledge/code-graph-structured.test.ts` |
| contract 镜像及项目编译 | 父 Agent 最终独立复核 Knowledge/Panel/web 三处 tsc 和 build、contract/diff 均通过 | canonical contract + 三份构建边界内副本 |

2026-10-19 父 Agent 最终独立回归：Knowledge 全部测试 86/86、Panel 全部测试 134/134 通过，三处 tsc、web build、契约同步及 diff 检查通过。本目录中回归日志保留了较早的 02:29 子 Agent 快照（Knowledge 相关 55/55、Panel 134/134），不将旧日志冒充最终全量输出。web build 提示现有 `teamApi` 同时静态/动态导入以及主包大于 500 kB，构建退出码为 0；这些提示不等同于首图交互时间证明。

## 性能方法和数据

完整原始样本在 `backend-performance-2026-10-19.json`，包含机器、Node、首次查询、未排序的 30 个样本、p50/p95/max 和最大 rowsRead。以 `structured-performance.test.ts` 重建夹具和报告，性能测试整组上限 120 秒；单次查询暖 p95 目标为 2,000 毫秒。

“首次”只是本进程该 mode 的第一次查询，不清除操作系统页缓存。依赖聚合的预热样本定位到 imports 边扫描阶段，并断言计数确实增加；不能用只扫描 node 的初始页代替聚合吞吐。源码声明文件和索引内容 hash 均存在。可选输出的浏览器数据为该夹具实际查询生成的 100 节点/300 边响应。

2026-10-19 02:36（Asia/Shanghai）由父 Agent 对最终实现独立采样，以下数值取自该完整原始报告，没有重新挑选较快样本。机器为 Apple M1、8 逻辑 CPU、16 GiB、Darwin 25.6.0 arm64、Node 22.23.0。开发主机同时存在构建负载，没有 CPU/磁盘隔离；采样开始 1/5/15 分钟负载为 12.51/11.66/9.13，结束为 14.19/12.05/9.30。

| mode | 首次查询 ms | 30 次预热样本 p95 ms | 最大读取行操作 |
| --- | ---: | ---: | ---: |
| calls | 5.99 | 5.42 | 400 |
| impact | 3.22 | 2.74 | 50 |
| hierarchy | 0.67 | 1.02 | 18 |
| dependencies | 7.62 | 1321.20 | 1996 |
| clusters | 8.30 | 74.84 | 1996 |

聚合模式的首次查询是初始目录扫描，预热样本是实际 imports 边阶段；报告额外保留第一次进入该阶段的 `phaseFirstMs`。五种 mode 的 p95 均满足 2,000 ms 后端目标。浏览器响应完成后 1 秒内可交互的目标由父 Agent 使用独立浏览器计时验收，不能由这些后端数据推断。

### 浏览器首图交互

父 Agent 在独立 Chrome 155.0.8059.82 会话中复跑 100 节点/300 条边：首次图挂载 122.5 ms，30 次暖样本 p50 89.35 ms、p95 117.2 ms、最大 121.6 ms，31 次均小于 1,000 ms。原始结果为 `ui-performance-parent-2026-10-19.json`；子 Agent 更早的独立结果保留在 `ui-performance-2026-10-19.json`（首次 523.2 ms、暖 p95 123.1 ms），没有删除较慢结果。

数据来自 5,000/15,000 合成 SQLite 基准的实际 structured adapter 响应，经 HTTP 夹具重映射资产和版本 ID。测量从 ResourceTiming.responseEnd 到实际画布节点点击改变详情，再等待两帧；包含自动化点击开销，不包含后端提取和网络耗时。使用 Apple M1、16 GiB、8 逻辑 CPU、1600×1000 视口，无 CPU 限速和动画覆盖；首次指本次页面加载后的首次图挂载，未清除操作系统或浏览器缓存。该性能测试与真实 SDK 浏览器联调是两组不同证据。

### 浏览器回归

| 范围 | 实际通过检查 | 证据 |
| --- | ---: | --- |
| 调用和旧流程最终回归 | 49：smoke 7、races 8、states 17、visual 13、theme 4 | `output/playwright/codegraph-calls-acceptance.md`；包含文本查询/同步、键盘、无 WebGL、窄屏、主题和中英文 |
| 影响/依赖/继承交互 | 30；父 Agent 已独立复跑 | `MemoryPanel/tests/knowledge/browser/code-graph-modes.js` |
| 新模式异常提示与竞态 | 11；父 Agent 最终独立复跑 | `mode-states-browser-parent-2026-10-19.json` |
| 聚类完整交互 | 21；父 Agent 最终独立复跑 | `clusters-browser-parent-2026-10-19.json` |
| 真实 SDK 到浏览器联调 | 15；父 Agent 最终独立复跑 | `live-browser-parent-2026-10-19.json` |

上述共 126 项场景检查；不与单元/服务测试或性能样本混算。真实浏览器联调覆盖五种模式、JavaScript 调用、真实循环依赖、聚类下钻与边界、证据第 1000 行、最多 300 行源码以及跨模式同一索引版本；父 Agent 本次实际发出 13 次 graph、9 次 source 请求。

首次聚类复跑在并行 HMR 期间发生点击超时，稳定代码后的新会话 21 项全部通过。调用状态测试的一次失败来自旧版泛化截断提示断言，改为现有明确扫描提示后重跑 17 项通过。真实链路脚本先等待目录读取结束再提交搜索，并使用真实完整文件名，修正的是测试前置条件，未用 mock 图响应掩盖失败。

## 必须对用户保留的能力说明

- 当前明确验证的 SDK 为 1.6.2，语言为 TypeScript 和 JavaScript；未验证版本/schema 不静默降级为成功空图。
- Knowledge 的 SDK 依赖已精确固定为 `1.6.2`；其各平台可选包也由上游该版本精确固定为 `1.6.2`。这避免新构建从原 `^1.2.0` 范围选到未经验证的 SDK，并不等于完整依赖树锁定；本次未重装依赖或构建 Docker。
- SDK 未提取测试中的 TypeScript `interface extends`。类继承与类实现接口可用，接口向父级查询返回 unsupported；其他相关查询显示缺口提示。
- SDK 的 `export * from` 测试没有产出 imports 边。依赖聚合“扫描完整”只表示已遍历当前索引，不表示全部源码关系或运行时关系已提取。
- 潜在影响属于静态证据，不预测实际故障或声明运行时完整性。
- 聚类是目录分组，不是自动社区发现或语义架构认定。
- `aggregation.merge=replace`，继续加载覆盖累计计数，不能把每页计数相加。未完成扫描时没有检测到环不等于无环。
- 聚类符号层保留同一声明的多个真实端点，跨层对账使用 `aggregation.distinctSiteCount`，不能用符号层 edge.count 的和充当声明总数。
- 索引更新会使旧节点、游标和源码失效；源码工作树与索引 hash 不符时必须重新索引，不能拼接新旧数据。

## 可重复命令

从仓库根目录执行，并使用 Node 22（本机其他工作目录可能自动选择 ABI 不兼容的 Node 26）：

```sh
export PATH=/Users/zj/.hermes/node/bin:$PATH
node tools/sync-code-graph-contract.mjs --check
npm --prefix MemoryKnowledge run typecheck
MemoryPanel/node_modules/.bin/tsc -p MemoryPanel/tsconfig.json --noEmit
MemoryPanel/web/node_modules/.bin/tsc -p MemoryPanel/web/tsconfig.json --noEmit
MemoryKnowledge/node_modules/.bin/vitest run MemoryKnowledge/src/engines/code MemoryKnowledge/src/routes/code-graph-structured.test.ts
MemoryPanel/node_modules/.bin/vitest run MemoryPanel/tests
CODEGRAPH_BENCHMARK_REPORT=/tmp/codegraph-backend-performance.json CODEGRAPH_BENCHMARK_DATASET=/tmp/codegraph-browser-dataset.json MemoryKnowledge/node_modules/.bin/vitest run MemoryKnowledge/src/engines/code/structured-performance.test.ts
```

## 最终审核

结论：通过本期验收，可完成 QA `task-efyw0cfktm` 和父 Spec `task-efu42brav1`。六个开发子任务均已逐项验收；本次新增结构化接口与五视图入口、搜索/过滤/逐层展开、源码证据、权限/版本/预算边界、旧功能回归和性能目标都有可重放证据。

父 Agent 独立运行 Knowledge 86/86、Panel 134/134；最后诊断提示调整后另复跑图模型 9/9。三处 typecheck/build、契约同步和 diff 检查通过。`final-knowledge-tests.log`、`final-panel-tests.log`、`final-performance-tests.log` 和三份 `final-*-build.log` 是本地运行输出；命令及结构化持久证据保留在本报告和相邻 JSON 文件中。

审核中已修正同声明多符号漏边、符号 SCC/自环、范围外悬空 focus、累计未解析诊断、计数跨层对账、旧响应恢复失效图、源码证据定位及 SDK 构建版本漂移等问题。当前 SDK 的接口继承和星号再导出缺口如上明示，不伪造成功关系。

剩余非阻塞限制：既有全局应用外壳在 375px 下的头部重叠仍存在，关系图的窄屏面板与焦点恢复已通过，但不宣称整个应用外壳已适配手机。web build 仍有既有包大小和混合导入警告。工作区其他改动保持原状；没有新建提交或执行部署、生产索引重建。

清理：两套临时 Knowledge/Panel 服务均正常退出，四个随机端口已释放，临时仓库/索引目录已删除。本任务 Vite 15173 已停止，原有 5173 服务保留。
