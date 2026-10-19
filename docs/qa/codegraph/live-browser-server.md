# 浏览器连接真实 CodeGraph 链路

`MemoryPanel/tests/knowledge/live-codegraph-server.ts` 在临时 Git 仓库上运行安装的真实 SDK，启动随机 loopback 端口的 Knowledge 和 Panel HTTP 服务。图、聚合、证据、源码和版本全部来自生产代码；目录、身份与 ACL 元数据仍是明确的测试夹具。不会连接生产服务或使用现有 5173 端口。

## 启动与清理

从仓库根目录启动，保持进程运行：

```sh
CODEGRAPH_LIVE_METADATA=/tmp/codegraph-live-browser.json \
PATH=/Users/zj/.hermes/node/bin:$PATH \
MemoryPanel/node_modules/.bin/tsx MemoryPanel/tests/knowledge/live-codegraph-server.ts
```

等待 `CODEGRAPH_LIVE_READY`。JSON 文件给出 `panelBaseUrl`、`knowledgeBaseUrl`、`headers`、真实 `asset`/commit/stats，以及供目录和身份 mock 使用的 `user`、`team`、`agent`。也可读取 Panel 的 `GET /__fixture`。端口和 PID 每次不同，不复用历史报告里的连接值。

结束时在前台按 Ctrl+C。后台运行时，读取本次元数据 PID 并发送 SIGTERM：

```sh
PATH=/Users/zj/.hermes/node/bin:$PATH node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const metadata = JSON.parse(readFileSync('/tmp/codegraph-live-browser.json', 'utf8'));
const active = await fetch(metadata.panelBaseUrl + '/__fixture').then(response => response.json());
if (active.pid !== metadata.pid || !Number.isSafeInteger(metadata.pid)) throw new Error('Fixture identity changed');
process.kill(metadata.pid, 'SIGTERM');
JS
```

退出处理会关闭两个 HTTP 监听器及索引，并删除临时仓库。元数据 JSON 可作为测试运行信息保留；已退出服务的旧 metadata 不能继续使用。

## 浏览器连接方法

浏览器仍可 mock 应用的目录、登录和团队展示接口，但必须把以下五个 POST 直接转发至真实 Panel 服务，不能从 mock 函数生成 graph 响应：

`/api/v1/knowledge/code-graph/graph`、`graph-search`、`graph-tree`、`graph-node`、`graph-source`。

转发时使用 metadata 的 headers，保留原 JSON 请求体、真实响应状态和响应体。例如 Playwright 的 route handler 可用 `route.fetch({ url: metadata.panelBaseUrl + pathname, headers: metadata.headers, postData: route.request().postData() })`，再 `route.fulfill({ response })`。目录只展示 `metadata.asset`，其 ID 与服务器授权资产一致。

不要替换 SDK 返回的节点 ID、边 ID、indexVersion、源码、聚合计数或能力状态。这样才能发现 UI 对真实数据的假设错误。`search` 和 `explore` 旧文本入口也由真实服务器支持，可同样转发。

## 可重放检查

- 搜索 `entry`，完整路径区分 `src/main.ts` 和 `other.ts`，打开真实源码。
- `src/main.ts` 的 entry 调用 leaf；以 leaf 看潜在影响，可见 entry、top 和 late 等真实关系。
- Child 继承 Base 并实现 I；接口向上查询展示已知不支持说明。
- 默认依赖目录图包含 `alpha` ↔ `beta` 的循环导入证据。
- 聚类从目录进入文件和符号，再返回；查看 scope 外的边界端点和计数完整性。
- late.ts 的导入在第 1000 行，关系证据应定位到该行附近的真实源码。
- 仓库含 7 个 TS/JS 文件；当前 SDK 的确切 node/edge 数量使用本次 metadata，不能硬编码为跨版本保证。

这是本地集成证据，不是生产鉴权系统或生产 SDK 部署版本的验证。服务器只监听 `127.0.0.1`，固定凭据仅供这组测试使用。
