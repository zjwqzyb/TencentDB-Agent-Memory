"""Revision-aware task operations matching agents/tools/issues.py's JSON API.

The CLI and MCP use the same native issue routes. Credentials stay in private config;
there is no shell execution, legacy task write fallback or automatic conflict retry.
"""

import re

STAGES = ("backlog", "todo", "in_progress", "in_review", "done", "cancelled")
TRIAGES = (
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
)
ISSUE_FIELDS = {
    "kind",
    "stage",
    "triage",
    "labels",
    "parent_id",
    "blocked_by",
    "assignee_agent_id",
    "milestone",
    "acceptance",
    "evidence",
}
FILTERS = ("query", "state", "stage", "triage", "label", "parent_id", "ready")


class TaskRequestRejected(ValueError):
    """A validation failure known to precede any write."""

    definite_rejection = True


def task_id(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", value)
        or value.isdigit()
    ):
        raise TaskRequestRejected(
            "Use the full internal task_id, not a numeric issue number"
        )
    return value


def integer(value, name, minimum, maximum=None):
    if (
        type(value) is not int
        or value < minimum
        or (maximum is not None and value > maximum)
    ):
        raise TaskRequestRejected("Invalid " + name)
    return value


def issue_patch(request):
    issue = request.get("issue", {})
    if not isinstance(issue, dict) or set(issue) - ISSUE_FIELDS:
        raise TaskRequestRejected(
            "issue must contain only editable task workflow fields"
        )
    issue = dict(issue)  # Omitted fields stay omitted; arrays replace as in the CLI.
    if "status" in request:
        stage = {"running": "in_progress", "completed": "done"}.get(
            request["status"], request["status"]
        )
        if stage not in STAGES or ("stage" in issue and issue["stage"] != stage):
            raise TaskRequestRejected("Invalid/conflicting status; use issue.stage")
        issue["stage"] = stage
    if "stage" in issue and issue["stage"] not in STAGES:
        raise TaskRequestRejected("Invalid issue.stage")
    if "triage" in issue and issue["triage"] not in TRIAGES:
        raise TaskRequestRejected("Invalid issue.triage")
    return issue


def scoped_get(api, binding, identifier):
    item = api("meta/issue/get", {"task_id": task_id(identifier)})
    if item.get("task_id") != identifier or item.get("team_id") != binding["team_id"]:
        raise TaskRequestRejected("Task is outside this session team")
    return item


def list_tasks(request, binding, api):
    payload = {
        "team_id": binding["team_id"],
        "limit": integer(request.get("limit", 20), "limit", 1, 100),
        "offset": integer(request.get("offset", 0), "offset", 0),
    }
    payload.update({key: request[key] for key in FILTERS if key in request})
    if "ready" in payload and type(payload["ready"]) is not bool:
        raise TaskRequestRejected("ready must be boolean")
    if "all" in request and type(request["all"]) is not bool:
        raise TaskRequestRejected("all must be boolean")
    result = api("meta/issue/list", payload)
    if not request.get("all"):
        return result
    items = list(result["items"])
    while payload["offset"] + len(result["items"]) < result["total"]:
        if not result["items"]:
            raise TaskRequestRejected(
                "Incomplete task listing; do not treat it as no tasks"
            )
        payload["offset"] += len(result["items"])
        result = api("meta/issue/list", payload)
        items.extend(result["items"])
    return {"items": items, "total": len(items)}


def execute(request, binding, api, once):
    operation = request["operation"]
    if operation == "list":
        return list_tasks(request, binding, api)
    if operation not in ("get", "create", "update", "comment"):
        raise TaskRequestRejected("Unsupported task operation")
    identifier = request.get("task_id") or binding.get("task_id")
    if operation != "create":
        if not identifier:
            raise TaskRequestRejected(
                "No task selected; bind a task or supply its full task_id"
            )
        identifier = task_id(identifier)
    if operation == "get":
        return scoped_get(api, binding, identifier)
    if not isinstance(request.get("request_id"), str) or not request["request_id"]:
        raise TaskRequestRejected("request_id is required for task writes")
    if operation == "create":
        title = request.get("title")
        if not isinstance(title, str) or not title.strip():
            raise TaskRequestRejected("Task title required")
        payload = {
            "team_id": binding["team_id"],
            "title": title,
            "linked_agents": [{"agent_id": binding["agent_id"]}],
            "issue": issue_patch(request),
        }
        for field in ("description", "source_url"):
            if field in request:
                payload[field] = request[field]
    else:
        revision = integer(
            request.get("expected_revision"), "expected_revision (read task first)", 0
        )
        payload = {"task_id": identifier, "expected_revision": revision}
        if operation == "comment":
            body = request.get("body")
            if not isinstance(body, str) or not body.strip():
                raise TaskRequestRejected("Comment body required")
            payload["body"] = body
        else:
            payload["issue"] = issue_patch(request)
            payload.update(
                {
                    key: request[key]
                    for key in ("title", "description")
                    if key in request
                }
            )
            if not payload["issue"] and not any(
                key in payload for key in ("title", "description")
            ):
                raise TaskRequestRejected("No task changes supplied")
    route = "meta/issue/" + operation
    # Include route/scope in the durable digest; retries return the original result
    # before checking a revision that the first successful call already advanced.
    digest = {
        "route": route,
        "team_id": binding["team_id"],
        "agent_id": binding["agent_id"],
        "body": payload,
    }

    def mutate():
        if operation != "create":
            current = scoped_get(api, binding, identifier)
            if current["issue"]["revision"] != payload["expected_revision"]:
                raise TaskRequestRejected(
                    "Task revision conflict; get the task, review changes and use a new request_id. No write was made."
                )
        return api(route, payload)

    return once(request["request_id"], digest, mutate)
