# Codex 团队资产 MCP + Hooks

这套适配器让 Codex 直接使用 MemoryPanel 的团队资产，同时保留现有模型、provider 和 ChatGPT 登录。MCP 负责资产工具，Hooks 负责会话上下文、记忆召回和按需归档；不经过 Memory Proxy。

本目录收录本地 MCP/Hook、共用 API 运行时、安装/迁移脚本、配置模板和离线测试。所有地址、路径和身份 ID 均需由部署者配置，仓库不包含访问令牌或运行时数据库。原来的 Proxy 接入见 [Codex Proxy 说明](../README.md)，其中修改 provider、Proxy 路由、Plan 模式的要求只适用于该接入方式。

## 架构与范围

```text
Codex ── stdio MCP ── 本地启动器/监督器 ── 本地 API 运行时 ── HTTP(S) ── Panel
  │                                         │
  └── Hook JSON ── 本地 Hook/SQLite ──────────┘
                            每项目 runtime.sqlite3：绑定、代际、写入去重
```

MCP 和 Hooks 的正常调用都不再经过 SSH，也不需要启动 Docker 容器。`server/*.py` 是保留目录名的共用运行时源码，安装器将其复制到本地 `runtime/`；目录名不表示它必须远端部署。Panel 后端仍负责原生 API、用户认证和业务 ACL。

- 本地以真实工作目录匹配 `projects.json`，解析符号链接，优先匹配最深的项目目录。未配置目录不会回退到其他项目。
- 每个本地凭据配置限定一个 Team，凭配置用户的密钥访问 Panel；会话只能在该团队内选择用户拥有的有效 Agent，并选择与 Agent 关联的任务。
- 每个项目独立配置文件、本地运行时 SQLite 状态和 Hook 队列。记忆目标按所选 Team + Agent 派生。同一 Team + Agent 对应同一份长期记忆；需要独立记忆时应使用不同 Agent。
- Session 使用客户端提供的真实 ID，绑定带 `generation`。重新选择不会改写旧代际，旧队列与子 Agent 保留原来的保存目标。
- 只使用 Hook 事件字段，不扫描旧聊天、transcript、工具日志或内部推理。Wiki、代码图和 Skill 必须在后台实际挂载；工具可用不表示资产已有内容。

## 环境要求与兼容边界

本地需要 Python **3.11+**、能直接访问的 MemoryPanel HTTP(S) 地址，以及能提供下列事件的 Codex 客户端。Panel 必须部署相应原生 API。Python 实现只使用标准库，无需 OpenSSH、Docker 或额外 Python 包。

| Hook | 本实现读取的事件字段 | 用途 |
| --- | --- | --- |
| `UserPromptSubmit` | `cwd`, `session_id`, `turn_id`, `prompt` | 查询绑定，召回记忆，注入上下文，启用采集时暂存用户输入 |
| `Stop` | `cwd`, `session_id`, `turn_id`, `last_assistant_message` | 归档本轮用户输入与最终回复 |
| `SubagentStart` | `cwd`, 父 `session_id`, `turn_id`, 子 `agent_id`, 可选 `agent_type` | 固定继承父会话绑定 |
| `SubagentStop` | 同上及 `last_assistant_message` | 归档子 Agent 最终报告 |

以上是此适配器的输入契约，不表示所有 Codex 版本都支持全部事件。缺少真实标识时会跳过采集，绝不猜测目标。需要客户端实际加载 `hooks.json` 并向 Hook 进程提供这些字段；仅配置 MCP 无法自动获得每轮上下文或最终回复。子 Agent 测试覆盖的是回调契约，不等同于已在所有客户端完成真实子 Agent 验收。

官方参考入口：[MCP](https://developers.openai.com/codex/mcp)、[高级配置](https://developers.openai.com/codex/config-advanced)、[配置参考](https://developers.openai.com/codex/config-reference)。客户端配置和 Hook 能力以所用版本为准。本目录的自动化测试验证适配器自身，不验证客户端的版本兼容性。

## Panel 连接与本地凭据

先在 MemoryPanel 准备有效用户、Team、该用户拥有的 Agent，并把需要的 Wiki、Code Graph、记忆资产挂载到 Agent。`service_id` 与 `user_key` 是业务用户凭据，`user_id` 必须与凭据身份对应，不能使用管理员身份绕过团队 ACL。

Panel 地址使用**本机可直接访问的根地址**，例如 `http://panel.example.internal:8125`，不包含 `/api/v1`。已有内网 HTTP 可直接使用；公开网络使用部署好的 HTTPS。不会自动跟随 HTTP 重定向，避免认证头发送到其他地址，应填写最终地址。

安装后创建仅当前用户可读的配置：

```sh
install -d -m 0700 "$HOME/.codex/tencent-memory/config"
install -m 0600 agents/codex/mcp-hooks/examples/project.server.json \
  "$HOME/.codex/tencent-memory/config/example-project.json"
```

编辑该 JSON 中全部占位值：

| 字段 | 含义 |
| --- | --- |
| `name`, `team_name` | 项目与默认团队的展示名称 |
| `base_url` | 本机可访问的 Panel HTTP(S) 根地址 |
| `service_id`, `user_key` | 业务用户凭据，仅存于本机受保护文件中 |
| `user_id`, `team_id`, `agent_id` | 真实用户、默认团队和默认 Agent ID |

项目 key 是最长 64 字符的小写字母/数字/连字符，首字符不能是连字符；凭据文件名必须为 `<key>.json`，与本地项目映射一致。凭据不进入命令行、日志或 Git。不要用容器内部服务名配置本机无法解析的地址。

## 本地安装

新安装可在项目根目录执行：

```sh
python3 agents/codex/mcp-hooks/install.py --project-dir "$PWD"
```

默认安装到 `~/.codex/tencent-memory`，向 `~/.codex/config.toml` 增加 `mcp_servers.team_assets`，向 `~/.codex/hooks.json` 合并四类事件。支持 `--codex-home`、`--install-dir` 和 `--server-name` 指定独立安装位置，所有参数见 `--help`。

安装前先校验配置；已有同名 MCP 指向其他命令或不同 `cwd` 时会拒绝覆盖。已有适配器表保留其手动设置。只替换本适配器源码及同一命令的 Hook 项，不改模型、provider、登录文件、其他 MCP/Hook；存在的 `projects.json` 和 `state` 保留。每次实际变更在 `<codex-home>/backups/memory-mcp-时间/` 保存原文件及恢复清单。文件写入使用临时文件替换；多文件安装仍应避免客户端同时修改配置。

编辑安装目录的 `projects.json`。初始模板 `enabled=false`，不会连接任何项目。

```json
{
  "projects": [
    {
      "key": "example-project",
      "name": "示例项目",
      "path": "/absolute/path/to/project",
      "enabled": true,
      "team": "示例团队",
      "agent": "开发助手",
      "capture_conversations": false,
      "rename_on_bind": false,
      "transport": "http",
      "config_file": "/absolute/path/to/.codex/tencent-memory/config/example-project.json"
    }
  ]
}
```

`team`、`agent` 是初始化提示里的默认名称，真实 ID 和权限以 `config_file` 及实时 API 为准。`config_file` 必须是绝对路径，以 `<key>.json` 结尾；`transport` 为 `http`。旧 SSH 字段不会作为备用连接；旧部署须先完成下文的状态迁移。

- `capture_conversations=true`：部署者明确允许本项目初始化后自动归档用户输入、最终回复和子 Agent 最终报告。默认关闭。
- `rename_on_bind=true`：允许助手在成功绑定任务后，尝试用客户端原生标题工具把当前会话改为完整任务标题。默认关闭；工具失败不影响绑定，普通轮次不反复改名，用户本轮要求保留标题优先。
- 可用 `TENCENT_MEMORY_PROJECTS` 指定另一份本地映射文件；`TENCENT_MEMORY_STATE_DIR` 指定本地状态根目录。Hook 与 MCP 进程必须使用一致环境，路径应为绝对路径。

重启或重新加载客户端 MCP/Hook 运行时。手动配置模板见 [config.toml](examples/config.toml) 和 [hooks.json](examples/hooks.json)。命令里的 Python、脚本及项目路径必须替换为绝对路径；带空格时使用正确 shell 引号，安装器会自动处理 Hook 命令的引用。

**MCP 的项目取决于其进程工作目录。** 安装器的 `--project-dir` 会写入 MCP 的 `cwd`。Hook 则按每次事件的 `cwd` 路由。多项目部署时，两者必须指向同一项目；单个固定 `cwd` 的全局 MCP 表不会随聊天目录自动切换。为各工作区配置正确的 MCP `cwd`，或使用客户端支持的项目级 MCP 配置/独立配置目录，避免同时加载指向错误项目的全局项。本地 API 运行时不会跨项目自动寻找其他团队。

## 首次会话与任务绑定

首次输入后，Hook 注入真实 `session_id`、`generation` 和初始化状态。助手应先调用 `project_session choices`，让用户确认资产、团队、Agent 和任务；每次变更传当前 `expected_generation`。

```text
asset_confirm → confirm_assets(confirmed=true)
team_select → select_team(team_id)
agent_task_select → select_agent_task(agent_id, task_id)
initialized → 正常读取资产、召回和归档
```

有与所选 Agent 关联的任务时必须选择真实任务。用户已明确指定且唯一匹配时可以直接使用，不能自动挑第一项。只有成功查询并确认没有关联任务时，才允许空任务；用户只同意默认 Team/Agent 不代表跳过任务选择。

用户明确确认默认绑定且没有可选任务时，可用 `initialize_defaults(confirmed=true, expected_generation=...)` 合并初始化。查询失败不能当成空列表。会话已初始化但后来出现任务，可用 `select_agent_task` 补绑，服务端新建 generation；更换已绑定任务或 Agent 需要 `reset` 后重新初始化。`reset` 不删除历史记忆。

示例 MCP 参数（替换真实 ID，不要复制示例 ID 作为当前会话）：

```json
{"session_id":"REAL_SESSION_ID","operation":"status"}
```

```json
{"session_id":"REAL_SESSION_ID","operation":"confirm_assets","confirmed":true,"expected_generation":1}
```

读取完整的 `agent.prompt` 后，助手按用户所选角色工作，但角色配置和历史记忆不能覆盖更高优先级指令或当前用户要求。此流程不要求强制切换 Plan 模式。

## 工具和聊天工作流

14 个 MCP 工具全部要求真实 `session_id`。客户端展示的名称可能增加 MCP server 前缀。

| 工具 | 功能 |
| --- | --- |
| `project_session` | 查看状态/选项、确认资产、选择团队/Agent/任务、初始化默认值、重置 |
| `get_project_agent` | 实时读取所选 Agent 规则、Team、任务和资产索引 |
| `search_project_memory` | 查询 L0 原文、L1 提取，读取 L2 场景索引/相关场景和 L3 汇总 |
| `read_project_memory` | 按层读取挂载的记忆；L2 可传 `path` 读取场景全文 |
| `list_knowledge_bases` | 读取当前绑定上下文，资产在 `assets.knowledge.items` 中 |
| `list_documents` | 列出挂载 Wiki 的原始文档和页面 |
| `read_source_documents` | 按文件名读取 Wiki 原始文档 |
| `search_wiki` | 检索挂载 Wiki 页面 |
| `read_wiki_pages` | 按引用读取 Wiki 页面 |
| `query_code_graph` | `search` 检索符号，`explore` 查看代码关系 |
| `project_skills` | `list/search/read/file` 查看当前 Agent 的 Skill 和资源文件 |
| `manage_project_task` | 对齐新 CLI 的 list/get/create/update/comment，支持工作流、筛选、子任务和带 revision 的更新 |
| `create_project_skill` | 用当前 Codex 模型整理的具体内容创建 Skill |
| `extract_project_skill` | 显式请求后，提交当前代际已归档对话的服务端异步 Skill 抽取 |

任务指令及 CLI 对照见 [新版任务指令](TASK-COMMANDS.md)，包含 `mem:list-tasks`、`mem:ready-tasks`、`mem:get-task`、`mem:comment-task`、`mem:create-subtask`、`mem:claim-task`、`mem:complete-task` 和 `mem:cancel-task`。

`mem:help`、`mem:sync`、`mem:session-reset`、任务指令、`mem:create-skill` 是 Hook 告知助手的工作流提示，**不是客户端命令解析器或 Proxy 原生拦截**。助手仍需调用相应工具并检查成功结果，不能仅凭回复声称完成操作。

`mem:create-skill` 先整理可审阅的 `SKILL.md` 内容，再按用户授权写入。后台 `extract_project_skill` 使用服务端的抽取模型配置，需要对应功能已部署；提交成功只表示进入异步流程。当前轮最终回复尚未触发 `Stop` 时，不在服务端已采集的抽取范围中。

写工具使用稳定 `request_id`：每次独立意图分配新 ID，只有完全相同的重试才复用。`manage_project_task update/comment` 现在统一使用新 CLI 对应的 `meta/issue` 接口：先 get 读取 `issue.revision`，再提交 expected_revision。既支持历史任务的 revision=0，也支持托管任务；版本冲突要重新读取和审阅补丁，不自动覆盖，更不回退旧 task/update。创建任务不会自动更换当前绑定。

读取列表的部分接口最多返回前 100 项，记忆召回也有数量和上下文长度限制；需要完整内容时按工具支持的分页/路径读取。空 Skill/Wiki 列表代表尚无可用资产，不表示接口未接通。

## 采集、子 Agent 与数据边界

启用采集后，`UserPromptSubmit` 暂存经过常见密钥脱敏的输入；`Stop` 归档用户输入与 `last_assistant_message`。只保存用户/助手两类消息，分别调用记忆导入和 Skill 会话归档。L0 记忆按 Team + Agent 保存；任务 ID 保留在适配器绑定和 Skill 归档中，不承诺按任务隔离 L0。

本轮进行中的进度消息、工具输出和未结束轮次不会实时归档。初始化未完成、无法核实绑定、事件 ID 缺失或超出采集上限时会跳过或保留待检查状态。初始化中的输入仅在 `Stop` 确认同代际已初始化后才允许归档。

子 Agent 在 `SubagentStart` 获得父会话当时的 Team/Agent/任务/资产快照，工具用子 `agent_id` 作为 `session_id`。不重新询问选项，不允许管理写操作；最终报告标注模型来源及父子关系，通过 `SubagentStop` 归档。父会话随后 reset/补绑不会改变已有子 Agent 的目标。Hooks 本身不启动子 Agent，也不代表用户授权委派任务。

脱敏仅覆盖常见密钥格式和密码赋值，**不保证删除所有敏感信息**。关闭 `capture_conversations` 会停止自动归档；为召回而发送的查询文本仍会到达配置的服务端。需要完全停用时将该项目 `enabled=false` 并停止对应 MCP。

本地 `events.sqlite3` 含待发送文本、采集状态和审计记录；同一项目目录中的 `runtime.sqlite3` 含会话绑定、幂等账本和已采集片段。状态目录应仅对运行账户可读，按组织要求加密、备份和清理；当前实现没有自动保留期限。Hook 成功发送后清空 outbox 的消息 payload，本地运行时抽取片段仍会保留。不要把这些目录加入 Git。

## 断线、队列与恢复

MCP 监督器在本地 API 子进程退出后保持 stdio 可用；下次请求可重新启动子进程。HTTP 请求失败会返回安全的错误，不会切回 SSH。只有明确声明为只读且幂等的工具可自动重试。已经开始发送的写操作即使超时也不会自动重放，会返回 `Outcome unknown`，必须先核对服务端状态。

重连会核对 MCP 协议、capabilities 和完整工具清单。清单变化时要求重启 MCP，以免客户端继续使用旧契约。本地日志位于 `state/mcp/lifecycle-*.jsonl`，只记录生命周期元数据和错误分类，不记录请求内容或原始适配器 stderr。

Hook 队列位于 `state/<project-key>/events.sqlite3`：

| 状态 | 处理 |
| --- | --- |
| `queued` | 尚待处理，启用采集时后续 Hook 每次最多取两项 |
| `sent` | 成功，消息 payload 已清除 |
| `review` | 发送异常或结果不明，停止自动重放，需要人工核对 |

可先只读检查状态汇总：

```sh
sqlite3 /absolute/path/to/state/example-project/events.sqlite3 \
  'SELECT state, count(*) FROM outbox GROUP BY state;'
```

任务写入被明确校验/权限/版本拒绝时，`writes.status` 为 `rejected`，不自动重试；它与网络结果不明的 `uncertain` 不同。重新读取并形成新补丁后使用新 request_id。

本地 `state/<project-key>/runtime.sqlite3` 的 `writes` 账本按阶段记录 `request_id-memory` 与 `request_id-skill`。已完成阶段会返回去重结果；`pending/uncertain` 不允许自动重试。先备份数据库，检查原始请求的保存目标、账本与 Panel 实际数据。只有确认未发生写入或完成对账修复后，才由管理员决定恢复对应项；不要批量把 `review` 改回 `queued`，也不要用新 ID 盲重试。

## 排障

| 现象 | 检查与处理 |
| --- | --- |
| `No project configured` | `enabled`、绝对路径、符号链接实际位置、MCP 的 `cwd`；没有默认项目回退 |
| MCP 工具数量或名称仍旧 | 重启 MCP；确认运行的是此目录版本和正确包装器，不是旧的五工具 Wiki 服务 |
| Hook 无召回/无保存 | 客户端是否触发四类事件；输入 JSON 是否包含真实 ID；配置是否加载；采集开关是否开启 |
| 每轮要求初始化或看到其他团队 | 检查 Hook 的工作目录与 MCP 的固定 `cwd` 是否指向相同项目，勿猜测旧绑定有效 |
| 有任务却不能空绑定 | 调 `choices`，按所选 Agent 过滤并让用户选任务；服务端会检查超过第一页的关联任务 |
| HTTP 连接失败或重定向 | 本机可达性、Panel 最终地址与端口；不要继续使用 Docker 内部服务名；不会回退 SSH |
| `Panel configuration missing` | 检查 `config_file`、私有凭据文件和迁移状态 |
| `Panel HTTP 401/403` | 服务凭据、用户身份、有效团队成员资格、Agent 所有者和资产 ACL |
| `Panel HTTP 404` | 目标部署是否有该原生 API；本地源码有路由不代表运行镜像已更新 |
| Wiki 搜索为空 | 检查 `wiki_status`、原始文档及页面；元数据资产 active 不代表 Wiki 已构建 |
| 代码图 `ready` 但无检索结果 | 检查实际文件/节点数量和已索引 commit；状态字段本身不足以证明完成 |
| GitHub clone 报认证或 HTTP/2 `CANCEL/early EOF` | 区分权限与传输问题；私库使用对应平台及访问令牌，网络中断不要直接当成认证失败；在受控环境验证 HTTP/1.1、网络和重试策略 |
| L2/L3 为空 | 新记忆未生成场景/汇总时可能为空；区分空数据和接口错误，不伪称已有跨层内容 |
| Skill 抽取未见新 Skill | 查看后台异步任务和模型配置；本轮需要先完成 Stop 才会进入已归档范围 |
| 写操作结果不明 | 按上一节检查账本，禁止盲重试；日志不会输出原始载荷帮助“复现” |

## 从 SSH 部署迁移

凭据与会话/幂等账本原来在远端，不能只修改 URL 或从空数据库启动，否则当前 session 会丢失绑定和历史写入去重。

1. 暂停旧 MCP、Hooks 和其他使用同一运行时数据库的写入进程。等待在途请求结束，检查 `writes` 的 `pending/uncertain`；不明结果先对账。切换后不要同时运行旧、新写入端。
2. 在旧运行时导出私有 `<key>.json`，并使用 SQLite backup API 导出一致的 `runtime.sqlite3`。不要直接复制正在写入的主数据库文件。安全地传到本机受保护目录；这些是部署资料，不提交仓库。
3. 先运行本目录 `install.py` 安装共用本地运行时，保留现有 `projects.json`、`state` 和其他配置。再导入导出文件，指定本机可达地址：

```sh
python3 agents/codex/mcp-hooks/install.py
python3 agents/codex/mcp-hooks/migrate.py \
  --project-key example-project \
  --config-file /private/export/example-project.json \
  --runtime-db /private/export/runtime.sqlite3 \
  --panel-url http://panel.example.internal:8125
```

迁移工具不连接 SSH，不读取旧聊天，只导入明确提供的配置与状态。支持 `--install-dir` 和 `--state-dir`；状态根目录默认使用 `TENCENT_MEMORY_STATE_DIR`，未设置时使用 `<install-dir>/state`。MCP、Hook 和迁移工具须使用相同状态根目录。

导入会校验数据库完整性、v3 表结构和绑定团队，保留全部 generation、固定子 Agent 绑定、已采集片段及写入账本。原有 Hook 的 `events.sqlite3` 不变。先写凭据和状态，最后替换当前项目映射，清除旧 SSH 字段；其他项目记录不变。迁移会备份原配置并生成 `manifest.json`，凭据与数据库文件权限为 0600，目录为 0700。已有目标运行时数据库时拒绝覆盖。

4. 多项目安装对每个要启用的项目重复导入，或先禁用尚未迁移的条目。重新连接 MCP 并重新加载 Hook，检查 14 个工具、版本 3.2.0、正确团队/Agent 和原 generation。普通已初始化会话无需 reset、重新绑定或改名。
5. 核对 Hook 待发送队列和首轮 Stop 保存。历史 `review`、`pending/uncertain` 不会自动清空或重放。确认正常后停用旧适配器入口，保留受保护的旧快照以便对账。

回滚时先停用新写入端，按备份清单恢复配置。切换后产生过写入时必须先对账并迁回最新绑定/账本，不能直接用旧数据库覆盖；不得同时恢复两个可写副本。

仓库保留 `server/run-container.sh` 和旧远端包装器，便于识别和导出早期部署；当前本地启动器、Hook 和安装器不会调用它们。

## 升级与卸载

后续升级先备份本地 `config.toml`、`hooks.json`、`projects.json`、私有 `config` 和每项目 `state`。运行中的数据库使用 SQLite backup API。安装器同步本地代码和 `runtime/`，保留已有项目映射、凭据、数据库和同名 MCP 的手动设置；新版本源码不会自动替换已启动进程，需重连 MCP。

切换安装目录前移除旧的本适配器 Hook 条目，避免双重采集，不影响其他扩展。升级任务适配器时 Panel/Core 必须有新版 `meta/issue` API。

卸载时删除本适配器 MCP 表和四类 Hook 中对应命令条目，保留其他配置，重启客户端后再移走源码。状态和凭据按数据保留要求单独处理，不因卸载自动删除。恢复安装备份时逐项核对清单，避免覆盖后来其他工具新增的设置。

## 开发验证

从仓库根目录运行，无需真实凭据、SSH 或生产服务：

```sh
python3 -m unittest discover -s agents/codex/mcp-hooks/tests -v
python3 -m compileall -q agents/codex/mcp-hooks
sh -n agents/codex/mcp-hooks/server/run-container.sh
```

测试包含在 PATH 无 SSH/Docker 时运行完整已安装 MCP/Hook 的真实本机 HTTP 回环、认证头和重定向隔离、迁移前后全表/队列一致性，并覆盖目录隔离、脱敏与采集开关、Hook 重复回调、结果不明队列、任务选择/分页/代际、新任务 CLI 契约、revision 冲突、评论与子任务、新指令、子 Agent 固定绑定、分阶段写入去重、MCP 子进程断线及禁止重放写操作、清单变更、EOF 队列排空、服务端 14 工具契约和安装器的配置合并。包装器测试使用假的 Docker 命令，不在生产创建容器或写入记忆。

上线验收另需在目标客户端验证实际 Hook 事件、正确项目绑定、首轮最终回复保存、跨会话召回，以及按需验证 Wiki/Skill/代码图。不能把离线测试通过当成生产资产已就绪。
