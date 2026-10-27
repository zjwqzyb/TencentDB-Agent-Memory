import { z } from "zod";
import {
  issueFieldsSchema,
  issuePatchSchema,
  issueStageSchema,
  triageSchema,
} from "./issue-model.js";
import { paginationInputSchema } from "../pagination.js";
const id = z.string().trim().min(1).max(200);
export const issueCreateSchema = z.object({
  team_id: id,
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100000).optional(),
  source_url: z.string().max(2000).optional(),
  linked_agents: z
    .array(z.object({ agent_id: id }))
    .max(100)
    .optional(),
  issue: issueFieldsSchema.default(() => issueFieldsSchema.parse({})),
});
export const issueGetSchema = z.object({ task_id: id });
export const issueUpdateSchema = z.object({
  task_id: id,
  expected_revision: z.number().int().min(0),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(100000).optional(),
  issue: issuePatchSchema.default({}),
});
export const issueCommentSchema = issueGetSchema.extend({
  expected_revision: z.number().int().min(0),
  body: z.string().trim().min(1).max(20000),
});
export const issueListSchema = z
  .object({
    team_id: id,
    query: z.string().max(500).optional(),
    stage: issueStageSchema.optional(),
    state: z.enum(["open", "closed"]).optional(),
    triage: triageSchema.optional(),
    label: z.string().max(60).optional(),
    parent_id: id.optional(),
    ready: z.boolean().optional(),
  })
  .merge(paginationInputSchema);
