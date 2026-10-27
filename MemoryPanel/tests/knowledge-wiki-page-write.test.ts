import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerKnowledgeWikiRoutes } from "../src/panel/http/routes/knowledge/wiki-routes.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

let app: Hono;
let allowed: boolean, isMember: boolean;
const write = vi.fn();
const invoke = vi.fn();
beforeEach(() => {
  allowed = true;
  isMember = true;
  write
    .mockReset()
    .mockResolvedValue({ items: [{ ref: "concepts/example", ok: true }] });
  invoke.mockReset().mockImplementation(async (action: string) => {
    const data = {
      "auth/verify": { valid: true, user: { user_id: "real-user" } },
      "asset/get": { asset_id: "wiki", team_id: "real-team" },
      "acl/check": { allowed },
      "team-member/get": isMember
        ? { user_id: "real-user", status: "active" }
        : null,
    }[action];
    return { code: 0, data };
  });
  const deps = {
    instanceRegistry: {
      resolve: () => ({
        instance_id: "test",
        gateway_endpoint: "http://unused",
        api_key: "test",
      }),
    },
    metaKernel: { invoke },
    knowledgeClientFactory: () => ({ wikiPageWrite: write }),
  } as unknown as PanelDeps;
  app = new Hono();
  registerKnowledgeWikiRoutes(app, deps);
});
const pages = [{ ref: "concepts/example", content: "# Updated page" }];
const request = (body: unknown) =>
  app.request("/knowledge/wiki/page/write", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tdai-Service-Id": "test",
      "X-Tdai-User-Key": "test",
    },
    body: JSON.stringify(body),
  });

describe("Wiki page write access gate", () => {
  it("uses authenticated team and actor instead of caller-supplied identities", async () => {
    const response = await request({
      wiki_id: "wiki",
      pages,
      team_id: "forged-team",
      user_id: "forged-user",
    });
    expect(response.status).toBe(200);
    expect(write).toHaveBeenCalledWith("real-team", "wiki", pages, "real-user");
    expect(invoke).toHaveBeenCalledWith(
      "acl/check",
      { user_id: "real-user", asset_id: "wiki", action: "write" },
      expect.anything(),
    );
  });
  it("rejects a reader without write permission", async () => {
    allowed = false;
    expect((await request({ wiki_id: "wiki", pages })).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects a caller outside the team", async () => {
    isMember = false;
    expect((await request({ wiki_id: "wiki", pages })).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { wiki_id: "wiki" },
    { wiki_id: "wiki", pages: [] },
    { wiki_id: "wiki", pages: [{ ref: " ", content: "text" }] },
    { wiki_id: "wiki", pages: [{ ref: "page", content: 1 }] },
  ])("rejects malformed input %#", async (body) => {
    expect((await request(body)).status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });
  it("enforces byte size and batch limits before forwarding", async () => {
    expect(
      (
        await request({
          wiki_id: "wiki",
          pages: [{ ref: "page", content: "中".repeat(180000) }],
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request({
          wiki_id: "wiki",
          pages: Array.from({ length: 11 }, () => pages[0]),
        })
      ).status,
    ).toBe(413);
    expect(write).not.toHaveBeenCalled();
  });
});
