# 新版任务 CLI 与 mem 指令

MCP + Hooks 的任务操作现在与 `agents/tools/issues.py` 使用相同的 `meta/issue/{list,get,create,update,comment}` API。旧任务和新托管任务都使用原来的完整 `task_id`。本说明针对直接 MCP 接入；Proxy 的命令拦截器是另一套实现，不会因更新本适配器自动升级。

3.2 起由本地 API 运行时直接访问 Panel HTTP(S)，不再经过 SSH；绑定与写入账本从远端完整迁到本地，迁移方法见 [使用说明](README.md#从-ssh-部署迁移)。任务命令和 revision 契约不变。

## 命令清单

这些 `mem:` 文本是助手工作流，Hook 注入用法，由助手调用 `manage_project_task`；不是 shell 命令或自动执行的客户端解析器。全部操作使用 Hook 提供的真实 `session_id`。执行写入需要用户或项目工作流已授权。

| 指令 | operation / 关键字段 | 对应 CLI |
| --- | --- | --- |
| `mem:list-tasks [筛选条件]` | `list`，支持 query/state/stage/triage/label/parent_id、limit/offset/all | `list` 及筛选参数 |
| `mem:ready-tasks` | `list, ready=true, all=true` | `list --ready --all` |
| `mem:get-task [完整任务 ID]` | `get`，省略 ID 时读当前绑定任务 | `get TASK_ID` |
| `mem:create-task [标题或要求]` | `create`，title/description/issue，可附 source_url | `create --file body.json` |
| `mem:update-task [修改要求]` | 先 `get`，再 `update`，带 expected_revision 和部分补丁 | `get` + `update TASK_ID --revision N --file patch.json` |
| `mem:comment-task [进度或讨论]` | 先 `get`，再 `comment`，带 expected_revision/body | `get` + `comment TASK_ID --revision N --body-file note.md` |
| `mem:create-subtask <父任务 ID> [要求]` | 核对父任务后 `create`，issue.parent_id=父任务 ID | `create` 的 issue.parent_id 字段 |
| `mem:claim-task [完整任务 ID]` | 核对 ready/父 Spec 后 `update`，同时设置 assignee_agent_id 和 stage=in_progress | `update` 的 issue 补丁 |
| `mem:complete-task [验证证据]` | 核验后 `update`，stage=done、acceptance、evidence | `update` 的 issue 补丁 |
| `mem:cancel-task [原因]` | 先 `get`，再 `update`，stage=cancelled，保留历史 | `update` 的 issue 补丁 |

`mem:help` 应显示上述命令，及原有的 sync/session-reset/create-skill 等指令。没有绑定任务时，可在详情/更新/评论中显式提供同团队的完整 ID；不能把数字 `#42` 当内部任务 ID，也不能默默新建一个任务代替。读取未绑定任务不会更改会话绑定。

创建任务会关联当前 Agent，但不会自动切换当前会话任务。要补绑或换绑，仍按 `project_session` 流程操作。子 Agent 可 `list/get`，不得执行 create/update/comment 或自行变更绑定。

## 更新任务的实际流程

例如用户发送：

```text
mem:update-task 把描述里的实现范围补充为支持原生评论接口，保留现有验收项
```

助手先调用：

```json
{
  "session_id": "REAL_SESSION_ID",
  "operation": "get"
}
```

返回中的 `issue.revision` 是修改版本。假设当前是 7，整理完整的新描述，并只提交要改的字段：

```json
{
  "session_id": "REAL_SESSION_ID",
  "operation": "update",
  "request_id": "UNIQUE_ID_FOR_THIS_PATCH",
  "expected_revision": 7,
  "description": "保留原有内容后整理的具体新描述"
}
```

未提交的 issue 字段保持不变。原生任务 API 会保存修改事件并返回新 revision。不要把用户的“补充描述”直接替换掉已有全部需求；如果只是记录进度，应使用 `mem:comment-task`。用户未指定具体内容时，先读取任务并从当前对话形成可审阅补丁；关键意图仍不明确才追问。`confirm/cancel` 仅适用于已有草稿的确认/取消，不作为描述文本写入。

CLI 的等价形式（先通过环境提供认证，不把密钥写入文件）：

```sh
python3 agents/tools/issues.py get TASK_ID
python3 agents/tools/issues.py update TASK_ID --revision 7 --file /absolute/path/to/patch.json
```

```json
{
  "description": "整理后的具体新描述",
  "issue": {"stage": "in_review"}
}
```

MCP 使用已有服务器凭据，用户无需为使用 mem 指令把 Panel 密钥复制到本机环境；直接运行原生 CLI 时仍需按其说明配置 `MEMORY_PANEL_URL/MEMORY_SERVICE_ID/MEMORY_USER_KEY/MEMORY_TEAM_ID`。

## 新 CLI 支持的工作流字段

`issue` 接受以下部分补丁，创建任务时也可提供。省略字段不会重置已有数据。

| 字段 | 用法 |
| --- | --- |
| kind | `spec / enhancement / bug` |
| stage | `backlog / todo / in_progress / in_review / done / cancelled` |
| triage | `needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix` |
| parent_id | 父任务的完整 ID；解除父子关系用 null |
| blocked_by | 阻塞任务 ID 数组，不能用描述文本替代真实关系 |
| assignee_agent_id | 负责人 Agent ID；解除分配用 null；与会话 Agent 绑定分开 |
| labels / milestone | 自由标签数组和里程碑；triage 角色不放进 labels |
| acceptance | `[{"text":"可验证标准","done":false}]` |
| evidence | 实际测试、核验结果、提交或其他验证证据 |

数组是整体替换。修改 labels、blocked_by、acceptance 前先读当前值，再保留仍适用的项目。不存在硬删除操作，取消用 cancelled。领取只允许从未分配且无未完成阻塞的 ready 候选中选择，不能自动挑列表第一项。父 Spec 是需求来源，不直接充当可领取实现任务。

完成任务由服务端检查：验收项全部完成、验证证据非空、阻塞已完成、子任务已关闭。助手不得伪造证据、自动勾选未验证项目或清空阻塞来绕过检查；子任务完成也不自动关闭父任务。历史已完成任务的兼容规则由服务端决定，不为修改旧标题而编造追溯证据。

旧 MCP 调用的 `status=running/completed` 仍兼容映射到 `issue.stage=in_progress/done`，但 **update 现在必须提供 expected_revision**。此别名不能绕过验收与证据检查；新调用优先使用 issue.stage。不要调用旧 `meta/task/update`，新接口不可用时也不回退。

## 版本冲突与重试

- `get` 返回的 `issue.revision=0` 是合法历史任务版本，不能用“版本为零”判断无任务。
- update/comment 每次都传上次读取的 expected_revision。遇到冲突先重新读取，比较他人修改，重新决定补丁；不能自动换最新 revision 覆盖。
- 每次独立写意图分配新 request_id。原样重试必须复用原 ID；成功请求返回缓存结果，即使任务 revision 已增加也不会再次写入。
- 明确的校验/权限/版本拒绝会在账本标记为 `rejected`；重新阅读后形成的新意图使用新 ID。
- 网络超时或结果不明标记为 `uncertain`。必须先对账，不能把它当明确失败并换 ID 重发。

任务表的完整工具 schema 保持为 `manage_project_task` 一个入口，所以工具数量仍为 14。schema 已变化，现有 MCP 连接必须重启后才能使用新参数；只有 Hook 文本更新、服务端工具仍是旧 schema 时，新工作流不会自动生效。
