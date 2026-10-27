# Triage roles

Use `issue.triage` for exactly one state role. Do not put triage roles in freeform `issue.labels`.

| Canonical role | Value | Meaning |
| --- | --- | --- |
| needs-triage | needs-triage | Awaiting evaluation |
| needs-info | needs-info | Waiting for clarification |
| ready-for-agent | ready-for-agent | Specified sufficiently for agent implementation |
| ready-for-human | ready-for-human | Human judgment or action required |
| wontfix | wontfix | Will not be implemented; close as cancelled |

Categories map to `issue.kind`: bug → bug, enhancement → enhancement. A parent specification uses kind spec. Development stage is independent of triage: backlog, todo, in_progress, in_review, done, cancelled. Do not use needs-info as a dependency flag; use native blocked_by relationships for ticket dependencies.
