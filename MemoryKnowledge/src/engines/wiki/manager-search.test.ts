import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWikiSourceManager, type WikiSourceManager } from "./manager.js";
import { buildPage } from "./ingest-v2/frontmatter.js";

let root: string, manager: WikiSourceManager;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wiki-search-"));
  mkdirSync(join(root, "project", "wiki"), { recursive: true });
  manager = createWikiSourceManager(join(root, "manager"));
});
afterEach(() => {
  manager.remove("test");
  rmSync(root, { recursive: true, force: true });
});
function page(file: string, title: string, type: string, body = "") {
  writeFileSync(
    join(root, "project", "wiki", file),
    buildPage({ title, type }, body),
  );
}
function register() {
  expect(
    manager.register({ name: "test", path: join(root, "project") }).status,
  ).toBe("ready");
}
describe("Wiki exact-title retrieval", () => {
  it("finds a normalized full title beyond truncated FTS candidates and prefers sources", () => {
    for (let i = 0; i < 30; i++)
      page(
        `noise-${i}.md`,
        `Order Rules ${i}`,
        "concept",
        "Order Rules ".repeat(30),
      );
    page(
      "exact.md",
      "ＯＲＤＥＲ—Rules",
      "source",
      "Long context ".repeat(3000),
    );
    page("same-title.md", "Order Rules", "concept");
    register();
    const result = manager.search("test", "order rules", 1, { hop: 0 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("ＯＲＤＥＲ—Rules");
    expect(result.results[0].type).toBe("source");
    const expanded = manager.search("test", "order rules", 8, { hop: 0 });
    expect(new Set(expanded.results.map((r) => r.path)).size).toBe(
      expanded.results.length,
    );
  });
  it("retains ordinary content search and handles empty punctuation queries", () => {
    page("one.md", "First topic", "source", "uniquecarrot");
    page("two.md", "Other topic", "source", "unrelated content");
    register();
    expect(
      manager
        .search("test", "uniquecarrot", 5, { hop: 0 })
        .results.map((r) => r.title),
    ).toEqual(["First topic"]);
    expect(manager.search("test", " — ， ", 5, { hop: 0 }).results).toEqual([]);
  });
});
