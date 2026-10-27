/**
 * overview.ts — 从页面和来源元信息生成确定性的知识导航。
 * 不从标题推断业务关系或实施状态；不调用 LLM 编写全局叙事。
 * 失败不影响摄取主流程；保留 LlmClient 参数以兼容现有调用方。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { LlmClient } from "./llm.js";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-overview");

/** 结构性文件不纳入综述输入，也不被综述覆盖。 */
const STRUCTURAL = new Set([
  "index.md",
  "schema.md",
  "purpose.md",
  "log.md",
  "overview.md",
]);

interface PageBrief {
  title: string;
  type: string;
  description: string;
  sources: string[];
}

function collectBriefs(wikiDir: string): PageBrief[] {
  const out: PageBrief[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry !== "media") walk(full);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const rel = relative(wikiDir, full).replace(/\\/g, "/");
      if (STRUCTURAL.has(rel)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const { frontmatter } = parseFrontmatter(content);
      out.push({
        title:
          typeof frontmatter.title === "string" && frontmatter.title.trim()
            ? frontmatter.title.trim()
            : entry.replace(/\.md$/, ""),
        type: frontmatter.type,
        description:
          typeof frontmatter.description === "string"
            ? frontmatter.description.trim()
            : "",
        sources: Array.isArray(frontmatter.sources)
          ? frontmatter.sources.filter(
              (x): x is string => typeof x === "string",
            )
          : [],
      });
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

/**
 * 生成/更新 wiki/overview.md。页太少（<2）时跳过（综述意义不大）。
 *
 * @returns 是否写入了 overview。
 */
export async function generateOverview(
  projectPath: string,
  _llm: LlmClient,
): Promise<boolean> {
  const wikiDir = join(projectPath, "wiki");
  const briefs = collectBriefs(wikiDir);
  if (briefs.length < 2) {
    log.debug("页面太少，跳过 overview 生成", { pages: briefs.length });
    return false;
  }

  // A navigation overview must not invent relationships or implementation status
  // from page titles. Build it deterministically from current page metadata and
  // original-source frontmatter; full evidence remains in the source documents.
  const rawDir = join(projectPath, "raw", "sources");
  const metadata = new Map<string, Record<string, unknown>>();
  if (existsSync(rawDir))
    for (const name of readdirSync(rawDir)) {
      if (!name.endsWith(".md")) continue;
      try {
        metadata.set(
          name,
          parseFrontmatter(readFileSync(join(rawDir, name), "utf-8"))
            .frontmatter,
        );
      } catch {}
    }
  const safe = (value: unknown) =>
    String(value ?? "未标注").replace(/[|\r\n]/g, " ");
  const lines = [
    "# 知识导航",
    "",
    "本页根据当前页面清单与原文元信息自动生成，提供主题和来源导航，不证明设计已实施或已经部署。摘要不替代原文的完整条件、例外及适用范围；冲突须回到来源核对。",
    "",
    "## 来源与引用边界",
    "",
    "| 来源页 | 原始文件 | 版本 / 状态 / 范围 |",
    "|---|---|---|",
  ];
  for (const b of briefs
    .filter((b) => b.type === "source")
    .sort((a, b) => a.title.localeCompare(b.title))) {
    const refs = b.sources.length ? b.sources : ["来源未标注"];
    for (const ref of refs) {
      const m = metadata.get(ref) ?? {};
      lines.push(
        `| [[${safe(b.title)}]] | ${safe(ref)} | ${safe(m.version)} / ${safe(m.status)} / ${safe(m.scope)} |`,
      );
    }
  }
  for (const [type, title] of [
    ["concept", "概念入口"],
    ["entity", "实体入口"],
  ]) {
    lines.push("", `## ${title}`, "");
    const selected = briefs
      .filter((b) => b.type === type)
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const b of selected)
      lines.push(
        `- [[${safe(b.title)}]]${b.description ? `：${safe(b.description)}` : ""}`,
      );
  }
  const body = lines.join("\n");
  const content = buildPage(
    {
      type: "overview",
      title: "Overview",
      description:
        "由当前页面及原文元信息生成的知识导航；设计、计划、实现及适用范围以来源为准",
      timestamp: new Date().toISOString(),
    },
    body,
  );
  writeFileSync(join(wikiDir, "overview.md"), content, "utf-8");
  log.info("overview.md written", {
    pages: briefs.length,
    bytes: content.length,
  });
  return true;
}
