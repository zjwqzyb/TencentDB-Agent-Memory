"""Task workflow catalog injected by the Hook; not a shell/Proxy command parser."""

COMMANDS = (
    (
        "mem:list-tasks",
        "list",
        "列出团队任务；支持 query/state/stage/triage/label/parent_id、分页及 all=true",
    ),
    (
        "mem:ready-tasks",
        "list",
        "查询可领取任务，传 ready=true、all=true；不要自动认领第一项",
    ),
    (
        "mem:get-task",
        "get",
        "读取当前绑定任务或用户指定的完整 task_id，包括 revision、评论、验收项、父子关系与阻塞",
    ),
    (
        "mem:create-task",
        "create",
        "创建任务，按用户要求整理 title/description/issue；自动关联当前 Agent，不自动更换会话绑定",
    ),
    (
        "mem:update-task",
        "update",
        "先 get，再以其 issue.revision 作为 expected_revision，提交用户要求的 title/description/issue 部分补丁",
    ),
    (
        "mem:comment-task",
        "comment",
        "先 get，再带 expected_revision 和 body 追加进度/讨论，保留原描述及评论",
    ),
    (
        "mem:create-subtask",
        "create",
        "先核实父任务属于本团队且未关闭，再创建 issue.parent_id=父 task_id 的子任务",
    ),
    (
        "mem:claim-task",
        "update",
        "读取待领取任务和父 Spec，核对未分配及 ready、无阻塞，再同时设置 issue.assignee_agent_id=当前 Agent 和 issue.stage=in_progress",
    ),
    (
        "mem:complete-task",
        "update",
        "先 get，核实全部验收项、实际验证证据、阻塞已完成及子任务已关闭，再提交 issue.stage=done、acceptance 和 evidence",
    ),
    (
        "mem:cancel-task",
        "update",
        "先 get，再按用户明确要求设置 issue.stage=cancelled；保留任务和历史，不做硬删除",
    ),
)


def instruction():
    return (
        "任务命令使用新版任务 CLI 的 meta/issue/list|get|create|update|comment 契约，均调用 manage_project_task。"
        "mem:help 应列出以下命令及用法；这只是助手工作流，不能把命令文本直接当 shell 执行。\n"
        + "\n".join(
            command + " → operation=" + operation + "：" + description
            for command, operation, description in COMMANDS
        )
        + "\n任务写入须有当前用户或项目工作流授权。用户未提供修改内容时，先读任务并结合当前对话整理可审阅补丁；"
        "缺关键字段才追问，不能把 confirm/cancel 当作描述内容。用户确认已有草稿时仅执行该草稿，取消时不写入。"
        "完整 task_id 不等于 GitHub 数字编号；未指定时使用当前绑定任务，没有绑定须选择或提供完整 ID，不能静默新建替代。"
        "update/comment 必须先 get；revision=0 也是合法历史任务版本，不要省略。每个新写意图用新 request_id，原样重试复用旧 ID；"
        "遇到 revision 冲突先重新读取、比较并重新形成补丁，不自动用新版本覆盖。结果不明时先对账，禁止换 ID 盲重试。"
        "issue 内未提交的字段不变，但数组整体替换；更改 acceptance/labels/blocked_by 前读取保留现有值。"
        "父子关系和依赖用 parent_id/blocked_by 原生字段，triage 与 stage 分开。status=running/completed 仅兼容映射到 in_progress/done；"
        "不得为了完成任务虚构 evidence、把未验收项标为完成、移除阻塞或自动关闭父任务。不要回退旧 meta/task/update。\n"
    )
