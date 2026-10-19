# CodeGraph 搜索修复验收记录

日期：2026-10-19  
状态：生产部署与验收通过。

## 后端与真实索引验证

搜索修复涉及的后端 4 个冻结文件通过审核；Knowledge 44 项测试和类型检查通过。由于 `querySearch` 也影响 `graph-tree` 及 Java/聚合定位，另独立验证结构化 Java SDK、预算、聚合和聚类相关的 4 个文件 31 项测试。累计覆盖 10 个文件、75 项测试，均通过。

真实索引快照包含 355,800 个节点。`SvcClaim`、`svcclaim`、`SVCCLAIM` 三种大小写查询的首屏都将两条完全匹配的类放在前两位。后端首屏返回 100 条、读取 103 条索引行，约 37ms，并返回 `node_budget` 截断原因和后续 cursor。完整扫描 274 页得到 11,109 个唯一节点，与原 JavaScript substring 谓词的全量预期逐 ID 一致，无遗漏、无重复。该毫秒数来自后端索引验证，不代表线上端到端 UI 延迟。

真实源码副本只包含两条 exact 类的源码文件，其余源码文件刻意缺失，但完整数据库仍在。这个隔离快照的索引版本为 `46a6e50a5b48483ef0fd87bcef314e10`；两个类的源码与 hierarchy 请求可访问，但这项验证没有声称覆盖完整源码继承关系。生产 UI 的 hierarchy 与 source 检查使用生产索引版本 `159ad760d68321fcc17ca05ac3dbd0b2`。

证据：`output/deployment/codegraph-searchfix-20261019/real-search-validation.json`、`output/deployment/codegraph-searchfix-20261019/validation.log`、`output/deployment/codegraph-searchfix-20261019/freeze.json`。

## Fixture 浏览器验证

冻结版浏览器脚本 `MemoryPanel/tests/knowledge/browser/code-graph-search.js` 共 26/26 项通过，冻结 SHA-256 为 `247d2691f161c249c32c02beac675180b12c48efbb7ab27581adbb548c07b99d`。它覆盖跨空页/部分页累计结果、100 条目标及 500 条上限、重复 cursor、预算暂停和续扫、terminal 与完成空结果、查询/范围变更取消旧请求、手动取消保留部分结果，以及首请求和后续 cursor 的 12 秒硬超时和迟到响应。

独立 fixture 抽验确认首请求超时会显示未完成提示并恢复搜索操作；后续 cursor 超时保留可继续状态；英文暂停提示只显示一条，并能看到 “Continue searching”。早期一次运行因上一场景残留的 `delayByAction` 覆盖了 cursor 延迟而失败；fixture/script 已在冻结前修正，最终独立运行 26/26 通过，该早期失败不属于产品问题。

fixture 全套结果：`output/playwright/codegraph-search-final-result.json`；独立超时与英文暂停记录：`output/playwright/codegraph-search-independent-review.json`。这些结果是 fixture 验证，不替代生产 UI 证据。

## 生产浏览器验证

生产 UI 验收针对真实生产 API，无路由 mock。`output/playwright/codegraph-search-production-result.json` 中 28 项通过：三种大小写查询均通过一次请求返回 100 条首屏，app 与 svc 两个 exact 类位于前两位，索引读取量为 103；两个类的 hierarchy 与 source 均使用版本 `159ad760d68321fcc17ca05ac3dbd0b2`；真实源码可见；1440px 与 1366px 桌面视口工作区适配；文件范围正确过滤；完整扫描的无匹配结果没有显示 partial 提示。

生产 UI 查询端到端耗时为 500–2,047ms（包含 SSH 网络与浏览器等待），其中 `SvcClaim` 首次测量为 1,596ms。这些是本次端到端观测值，不应解读为纯后端耗时。

额外生产浏览器抽验 `output/playwright/codegraph-search-production-extra-result.json` 的 8 项均通过：英文 “Load more results” 与 “Continue searching” 区分清楚；partial 提示仅出现一条；加载更多将结果追加到 200 条；宽 768px、高 900px 的视口下搜索与源码抽屉可达并适配 viewport；Escape 关闭搜索抽屉后键盘焦点返回触发控件。截图为 `output/playwright/codegraph-search-production.png` 与 `output/playwright/codegraph-search-production-narrow.png`。

上述生产 UI 证据覆盖搜索、继承视图与源码、文件范围、真实无匹配和窄屏抽屉；不代表所有关系图模式均逐项生产验收，其他关系视图布局属于独立 fixture 验证范围。

## 部署与回滚

修复提交为 `20b2d585132367a0ddb217c979b78c065a31af88`，生产 Hub 镜像为 `sha256:48a42344a8a26e8868e2509629ac2e28defe5f54c9d77dfe07bbcb3372029762`。旧候选 `5ee5a490` 因产物含 AppleDouble 文件而废弃，未作为生产镜像；最终 `48a42344` 通过 20 个产物文件、435 个继承哈希和 21 个 artifact 哈希校验，无意外 dist 文件。Core、环境、挂载和运行参数保持不变；原索引版本未重建或改变。Hub 与 Core 健康检查通过，Panel 和 Knowledge health 均返回成功。

回滚镜像为 `sha256:4e14be68361b7aa9b3b7fb47decfcf84ab96c2603cfecaf98fa876d0838ada4f`。回滚脚本：`/opt/tencent-agent-memory/releases/codegraph-searchfix-20261019/ops/rollback-codegraph-searchfix.sh`；配置备份：`/opt/tencent-agent-memory/releases/codegraph-searchfix-20261019/backup/config-images.env`。生产部署报告：`output/deployment/codegraph-searchfix-20261019/production-review.json`。

## 证据文件

- `output/deployment/codegraph-searchfix-20261019/real-search-validation.json`：真实索引首屏、源码访问与全量分页结果。
- `output/deployment/codegraph-searchfix-20261019/production-review.json`：生产镜像、健康状态、运行环境、回滚镜像及生产 API 检查。
- `output/playwright/codegraph-search-final-result.json`：冻结 fixture 脚本 26 项结果。
- `output/playwright/codegraph-search-independent-review.json`：独立首请求/续页超时和英文暂停状态检查。
- `output/playwright/codegraph-search-production-result.json`：真实生产 UI 28 项结果。
- `output/playwright/codegraph-search-production-extra-result.json`：真实生产英文 Load more、partial 提示及窄屏抽屉 8 项结果。
