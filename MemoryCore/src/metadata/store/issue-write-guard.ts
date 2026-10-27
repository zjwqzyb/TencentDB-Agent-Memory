import type { TaskEntity } from "../types.js";

export type IssueGraphSnapshot = Array<
  Pick<TaskEntity, "task_id" | "metadata_json" | "status">
>;
export class IssueWriteConflictError extends Error {}

/** Checked inside the same transaction as the write, after taking the team lock. */
export function assertIssueGraphUnchanged(
  current: IssueGraphSnapshot,
  expected: IssueGraphSnapshot,
): void {
  const signature = (rows: IssueGraphSnapshot) =>
    JSON.stringify(
      rows
        .map((t) => [t.task_id, t.metadata_json, t.status])
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
  if (signature(current) !== signature(expected)) {
    throw new IssueWriteConflictError(
      "Team issue graph changed; reload and retry",
    );
  }
}
