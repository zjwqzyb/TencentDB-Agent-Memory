import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateOverview } from "./overview.js";
import { buildPage, parseFrontmatter } from "./frontmatter.js";
import type { LlmClient } from "./llm.js";

let root: string;
const chat = vi.fn();
const llm = { chat } as unknown as LlmClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wiki-overview-"));
  mkdirSync(join(root, "wiki"));
  mkdirSync(join(root, "raw", "sources"), { recursive: true });
  chat.mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function page(
  file: string,
  title: string,
  type: string,
  sources: string[] = [],
) {
  writeFileSync(
    join(root, "wiki", file),
    buildPage({ title, type, sources }, "Source body"),
  );
}
describe("deterministic Wiki navigation", () => {
  it("retains provenance and scope without asking an LLM to infer relationships", async () => {
    page("design.md", "已批准设计", "source", ["design-v2.md"]);
    page("draft.md", "实现计划", "source", ["plan.md"]);
    page("concept.md", "订单", "concept");
    page("index.md", "结构页不应出现", "source");
    writeFileSync(
      join(root, "raw", "sources", "design-v2.md"),
      buildPage(
        {
          type: "source",
          version: "v2",
          status: "approved design",
          scope: "团队 A",
        },
        "Original",
      ),
    );
    expect(await generateOverview(root, llm)).toBe(true);
    const first = parseFrontmatter(
      readFileSync(join(root, "wiki", "overview.md"), "utf8"),
    );
    expect(first.body).toContain(
      "design-v2.md | v2 / approved design / 团队 A",
    );
    expect(first.body).toContain("plan.md | 未标注 / 未标注 / 未标注");
    expect(first.body).toContain("不证明设计已实施或已经部署");
    expect(first.body).toContain("[[订单]]");
    expect(first.body).not.toContain("结构页不应出现");
    await generateOverview(root, llm);
    expect(
      parseFrontmatter(readFileSync(join(root, "wiki", "overview.md"), "utf8"))
        .body,
    ).toBe(first.body);
    expect(chat).not.toHaveBeenCalled();
  });
  it("skips collections with fewer than two content pages", async () => {
    page("only.md", "Only", "source");
    expect(await generateOverview(root, llm)).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });
});
