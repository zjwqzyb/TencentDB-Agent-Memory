/**
 * The Skill extractor must resolve its runner ONCE per extract job so a
 * managed model switch cannot split one job across two configs.
 */

import { describe, expect, it, vi } from "vitest";
import { SkillExtractor, type ExtractorRunner } from "./skill-extractor.js";

function fakeCore() {
  const skill = {
    skill: {
      skill_id: "sk-1",
      name: "Existing skill",
      description: "does things",
      content: "body",
      version: 1,
      user_id: "u",
      team_id: "t",
      agent_id: "a",
      status: "active",
      created_at: "",
      updated_at: "",
    },
  };
  return {
    list: async () => ({ items: [skill], total: 3 }),
    search: async () => [skill],
  } as any;
}

describe("SkillExtractor runnerProvider (job-scoped runner)", () => {
  it("resolves the runner exactly once for query-gen + review calls", async () => {
    const calls: string[] = [];
    const runner: ExtractorRunner = {
      async run(params) {
        calls.push(params.prompt.slice(0, 24));
        return params.enableTools ? "" : "alpha beta";
      },
    };
    const provider = vi.fn(async () => runner);

    const extractor = new SkillExtractor({
      core: fakeCore(),
      runnerProvider: provider,
      prefixSkillsLimit: 2,
    });

    await extractor.extract({
      messages: [{ role: "user", content: "hello" } as any],
      task_id: "task-1",
      user_id: "u",
      team_id: "t",
      agent_id: "a",
      session_id: "s",
    });

    // query-gen + review => two upstream calls, one resolution
    expect(calls).toHaveLength(2);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("propagates a fail-closed resolution error instead of returning zero candidates", async () => {
    const extractor = new SkillExtractor({
      core: fakeCore(),
      runnerProvider: async () => {
        throw Object.assign(new Error("paused"), { code: "MODEL_SNAPSHOT_PAUSED" });
      },
      prefixSkillsLimit: 0,
    });

    await expect(extractor.extract({
      messages: [{ role: "user", content: "hello" } as any],
      task_id: "task-2",
      user_id: "u",
      team_id: "t",
      agent_id: "a",
      session_id: "s",
    })).rejects.toMatchObject({ code: "MODEL_SNAPSHOT_PAUSED" });
  });

  it("keeps the legacy runner when no provider is supplied", async () => {
    const runner: ExtractorRunner = { async run() { return ""; } };
    const extractor = new SkillExtractor({ core: fakeCore(), runner, prefixSkillsLimit: 0 });
    const result = await extractor.extract({
      messages: [{ role: "user", content: "hello" } as any],
      task_id: "task-3",
      user_id: "u",
      team_id: "t",
      agent_id: "a",
      session_id: "s",
    });
    expect(result.candidates).toEqual([]);
  });
});
