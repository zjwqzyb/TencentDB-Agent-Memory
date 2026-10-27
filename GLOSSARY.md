# Task vocabulary

- **Team**: the collaboration and authorization boundary for tasks, agents and issues. This first version scopes an issue project to an existing team.
- **Task**: the persistent work identity referenced by sessions and memories (`task_id`). Existing tasks keep their identity when used as issues.
- **Issue**: the machine-interface term for a task with development workflow, triage, relationships, acceptance criteria, verification evidence and discussion. The product UI calls it **任务 / Task** and calls a sub-issue **子任务 / Subtask**.
- **Spec**: a parent issue describing the desired outcome and scope. It is decomposed into implementation issues and is not itself offered to agents as ready work.
- **Sub-issue**: an issue with a parent_id; the parent summarizes child completion but is closed explicitly.
- **Blocker**: an issue referenced by blocked_by. Only done satisfies a blocker; cancelled requires an explicit dependency decision.
- **Ready frontier**: unassigned implementation issues in backlog/todo with ready-for-agent triage and no unresolved blockers.
- **Agent**: a team-scoped AI worker; assigning an issue records responsibility. Existing task-agent associations and session bindings remain separate runtime relationships.
- **Session**: an execution/conversation associated with an existing task identity.
- **Triage**: readiness and routing classification, separate from the development stage.
- **Evidence**: a human/agent supplied verification record. The system checks that it is present, not that the claimed tests actually ran.
