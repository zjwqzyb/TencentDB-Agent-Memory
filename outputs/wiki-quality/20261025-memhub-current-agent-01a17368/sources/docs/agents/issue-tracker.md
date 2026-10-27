# Issue tracker: MemoryPanel

This project uses its internal MemoryPanel issue tracker. Use the JSON CLI below; do not create GitHub issues for this workflow. This is the custom-tracker configuration consumed by mattpocock-skills. It does not install or invoke those skills automatically.

## Connection

The operator supplies `MEMORY_PANEL_URL`, `MEMORY_SERVICE_ID`, `MEMORY_USER_KEY`, and `MEMORY_TEAM_ID` through the environment. Never write keys to the repository or print them. If configuration is missing, request the missing connection information; do not silently switch trackers. Requires Python 3, with no extra packages.

Run from this repository root:

```sh
python3 agents/tools/issues.py list --ready --all
python3 agents/tools/issues.py get TASK_ID
python3 agents/tools/issues.py create --file /path/to/issue.json
python3 agents/tools/issues.py update TASK_ID --revision 3 --file /path/to/patch.json
python3 agents/tools/issues.py comment TASK_ID --revision 4 --body-file /path/to/progress.md
```

Every command returns JSON; a failure exits nonzero. `TASK_ID` is the full returned `task_id` (also used for session binding). It is not a GitHub issue number. Never abbreviate IDs in API operations. A bare numeric `#42` is ambiguous: request the full internal task ID.

List supports `--query`, `--state open|closed`, `--stage`, `--triage`, `--label`, `--parent-id`, `--ready`, `--limit` and `--offset`. Without `--all`, it returns one page. `--ready` returns non-spec issues in backlog/todo, labeled ready-for-agent, unassigned and with every blocker done. A cancelled blocker does not satisfy a dependency.

## Operations for skills

- **to-spec** (older versions: to-prd/write-a-prd): create an issue with `issue.kind: "spec"`; put the specification in the Markdown description. Use `issue.triage: "ready-for-agent"` when appropriate, but specs themselves are not returned by `--ready`.
- **to-tickets** (older versions: to-issues/prd-to-issues): create one issue per approved vertical slice, blockers first. Set `issue.parent_id` to the source spec's `task_id`; set `issue.blocked_by` to the blockers' full IDs. These are native relationships, not just prose. Set `issue.triage: "ready-for-agent"`, `issue.stage: "todo"` and a structured `issue.acceptance` list. Do not close or rewrite the parent.
- **triage**: read the full issue including comments. `issue.kind` maps bug/enhancement; `issue.triage` holds exactly one canonical role. Use comments for briefs and questions; retain the skill's required AI disclosure. For wontfix, set `triage: "wontfix"` and `stage: "cancelled"` together.
- **implement / implement-spec**: select work from the ready frontier. Read the full ticket and parent spec. Claim using one update with the current revision, `assignee_agent_id` and `stage: "in_progress"`. On a conflict, reload and choose again; never blindly retry a stale patch. Use comments for progress, blockers and handoffs. After implementation, use `in_review`; after verification, mark acceptance items done, record `evidence`, and set `stage: "done"`. Follow the invoking skill's review and human decision requirements.

Create body example:

```json
{
  "title": "Deliver the first end-to-end slice",
  "description": "## What to build\nDescribe observable behavior and scope.",
  "issue": {
    "kind": "enhancement",
    "stage": "todo",
    "triage": "ready-for-agent",
    "parent_id": "PARENT_TASK_ID",
    "blocked_by": [],
    "acceptance": [{"text": "The behavior is verified end to end", "done": false}],
    "labels": ["backend"],
    "milestone": "v1"
  }
}
```

Update body example (revision is supplied separately by the CLI):

```json
{
  "issue": {
    "stage": "done",
    "acceptance": [{"text": "The behavior is verified end to end", "done": true}],
    "evidence": "Test command, result, and relevant commit or PR link."
  }
}
```

Updates are partial at the field level; arrays replace their previous value. Read before changing acceptance, labels or dependencies. Comments are append-only and author identity is derived from authentication. Every mutation returns the new revision. Completion requires nonempty verification evidence, all acceptance checks, all blockers done and all direct sub-issues closed. Completing children does not automatically close the parent. Reopen a closed parent before adding open children.

## API contract and compatibility

All endpoints are `POST /api/v1/meta/issue/{create,get,list,update,comment}` through Panel, or `/v3/meta/issue/...` through Core with its existing gateway authentication. Headers are `X-Tdai-Service-Id` and `X-Tdai-User-Key`. Responses use the existing `{code,message,data,request_id}` envelope. `update` and `comment` require `task_id` and `expected_revision`; `create` derives the creator from authentication. All operations require active membership in the issue's team.

Issues extend existing tasks in `metadata_json.issue`; no task ID rewrite or destructive data migration is needed. Existing tasks appear as in_progress/done and gain issue data on the first issue update. Existing external metadata and session associations remain intact. Imported task sources remain available in the UI. Managed issues use issue/update instead of legacy task/update/archive; close/cancel replaces hard deletion so history survives. Legacy Proxy mem:update-task is not an issue editing interface; use this CLI for managed issues.

## Operational boundaries

The first version uses team-wide task scans for relationship validation and list filtering; very large teams will need indexed relationship storage. Revisions are checked atomically in SQLite and MongoDB, preventing lost comments and duplicate claims for the same revision. Graph writes validate the team snapshot inside the storage transaction; competing graph changes return a conflict instead of creating cycles. MongoDB issue graph writes require replica-set transactions, consistent with the existing production deployment requirement. MongoDB stores comments in the issue document and retains its normal document size limit.

Upstream references checked on 2026-10-18: [setup](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/SKILL.md), [to-tickets](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md), [triage](https://github.com/mattpocock/skills/blob/main/skills/engineering/triage/SKILL.md). User-invoked skills stay user-invoked; these instructions configure their tracker operations.

## Task naming and historical data

The UI uses **任务 / Tasks** and **子任务 / Subtasks**. `issue/*`, `issue` metadata and
`agents/tools/issues.py` remain the stable machine interface for existing skills and clients.

Historical tasks require no batch migration. Reads map `running` to `in_progress` and
`completed` to `done`, without rewriting storage. Existing task IDs, descriptions, external
source metadata, linked agents and session participation records remain attached to the same
row. The first edit/comment adds structured workflow metadata and preserves other metadata
namespaces. Older completed tasks may be annotated or renamed without inventing retrospective
verification evidence. Reopening them requires evidence before completing them again; new
unchecked criteria and unresolved dependencies still prevent completion.

Data compatibility does not imply old write-API compatibility: once upgraded by an edit or
comment, a task must be updated through the revision-aware `issue/update` endpoint or CLI.
The legacy `task/update` endpoint deliberately rejects managed tasks to protect their workflow.
