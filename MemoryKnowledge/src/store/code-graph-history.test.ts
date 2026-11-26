import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { closeIndex, indexProject, openIndex, syncIndex } from "../engines/code/bridge.js";
import { createCodeGraphRoutes } from "../routes/code-graph.js";
import type { CodeGraphRouteDeps } from "../routes/code-graph.js";
import type { CodeGraphResponse } from "../contracts/code-graph.js";
import { CodeGraphService } from "./code-graph-service.js";
import { captureCodeGraphHistory, findCodeGraphHistory, readHistoricalTree } from "./code-graph-history.js";
import type { CodeGraphRow, IKnowledgeStore } from "./types.js";

const temps: string[] = [];
let sourceRepo: string;
let dataRoot: string;
let assetDir: string;
let historyDir: string;
let row: CodeGraphRow;

beforeEach(() => {
  sourceRepo = mkdtempSync(join(tmpdir(), "cg-history-source-"));
  dataRoot = mkdtempSync(join(tmpdir(), "cg-history-data-"));
  temps.push(sourceRepo, dataRoot);
  assetDir = join(dataRoot, "svc", "team", "cg-history");
  historyDir = `${assetDir}.history`;
  row = {
    code_graph_id: "cg-history",
    service_id: "svc",
    team_id: "team",
    repo_name: "history fixture",
    repo_url: sourceRepo,
    branch: "main",
    commit_hash: null,
    owner_user_id: null,
    user_id: null,
    agent_id: null,
    task_id: null,
    visibility: "team",
    status: "ready",
    internal_status: null,
    sync_error: null,
    stats_json: null,
    service_url: null,
    summary: null,
    version: 0,
    last_sync_at: null,
    created_at: "2026-11-25T00:00:00.000Z",
    updated_at: "2026-11-25T00:00:00.000Z",
    deleted_at: null,
  };
});

afterAll(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

const store = {
  getCodeGraphById(serviceId: string, id: string): CodeGraphRow | null {
    return serviceId === row.service_id && id === row.code_graph_id ? row : null;
  },
  getCodeGraph(serviceId: string, teamId: string, id: string): CodeGraphRow | null {
    return serviceId === row.service_id && teamId === row.team_id && id === row.code_graph_id ? row : null;
  },
  updateCodeGraphStatus(_serviceId: string, _id: string, patch: Partial<CodeGraphRow>): void {
    Object.assign(row, patch);
  },
  appendCodeGraphAudit(): void {},
} as unknown as IKnowledgeStore;

async function commit(message: string): Promise<string> {
  const git = simpleGit(sourceRepo);
  await git.add(".");
  await git.commit(message);
  return (await git.revparse(["HEAD"])).trim().toLowerCase();
}

async function writeOldRevision(): Promise<void> {
  writeFileSync(join(sourceRepo, "package.json"), '{"name":"history-fixture","type":"module"}');
  writeFileSync(join(sourceRepo, "modify.ts"), "export function modifiedSymbol() {\n  return 'old body';\n}\n");
  writeFileSync(join(sourceRepo, "delete.ts"), "export function deletedSymbol() {\n  return 'only in old revision';\n}\n");
  writeFileSync(join(sourceRepo, "rename-old.ts"), "export function renamedSymbol() {\n  return 'same body after rename';\n}\n");
  writeFileSync(join(sourceRepo, "uncertain-old.ts"), "const unrelatedOld = 1;\nexport function uncertainSymbol() {\n  return unrelatedOld + 1;\n}\n");
}

async function writeNewRevision(): Promise<void> {
  writeFileSync(join(sourceRepo, "modify.ts"), "export function modifiedSymbol() {\n  return 'new body';\n}\n");
  unlinkSync(join(sourceRepo, "delete.ts"));
  unlinkSync(join(sourceRepo, "rename-old.ts"));
  writeFileSync(join(sourceRepo, "rename-new.ts"), "export function renamedSymbol() {\n  return 'same body after rename';\n}\n");
  writeFileSync(join(sourceRepo, "added.ts"), "export function addedSymbol() {\n  return 'only in new revision';\n}\n");
  unlinkSync(join(sourceRepo, "uncertain-old.ts"));
  writeFileSync(join(sourceRepo, "uncertain-new.ts"), "interface UnrelatedNew { value: string }\nconst unrelatedNew: UnrelatedNew = { value: 'different shape' };\nexport function uncertainSymbol() {\n  return unrelatedNew.value;\n}\n");
}

async function request(action: string, body: Record<string, unknown>): Promise<{ status: number; body: { code: number; data: CodeGraphResponse } }> {
  const deps = {
    cgService: {
      getById: (serviceId: string, id: string) => store.getCodeGraphById(serviceId, id),
      dirFor: () => assetDir,
      historyDirFor: () => historyDir,
    },
    instancePool: {},
    publicBaseUrl: "",
  } as unknown as CodeGraphRouteDeps;
  const response = await createCodeGraphRoutes(deps).request(`/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": "svc" },
    body: JSON.stringify({ code_graph_id: "cg-history", ...body }),
  });
  return { status: response.status, body: await response.json() as { code: number; data: CodeGraphResponse } };
}

function findSymbol(result: CodeGraphResponse, name: string) {
  return result.nodes.find(node => node.name === name);
}

function createFixtureWorker() {
  return async context => {
    mkdirSync(join(assetDir, ".."), { recursive: true });
    if (!existsSync(join(assetDir, ".git"))) {
      await simpleGit().clone(sourceRepo, context.dir, { "--depth": 1, "--branch": "main" });
    } else {
      const target = simpleGit(context.dir);
      await target.fetch("origin", "main", { "--depth": 1 });
      await target.raw(["reset", "--hard", "FETCH_HEAD"]);
      await target.clean("df", ["-e", ".codegraph"]);
      const instance = await openIndex(context.dir);
      await syncIndex(instance);
      const stats = instance.cg.getStats();
      closeIndex(instance);
      return {
        commitHash: (await simpleGit(context.dir).revparse(["HEAD"])).slice(0, 12),
        stats: { files: stats.fileCount ?? 0, nodes: stats.nodeCount ?? 0, edges: stats.edgeCount ?? 0 },
      };
    }
    const instance = await indexProject(context.dir);
    const stats = instance.cg.getStats();
    closeIndex(instance);
    return {
      commitHash: (await simpleGit(context.dir).revparse(["HEAD"])).slice(0, 12),
      stats: { files: stats.fileCount ?? 0, nodes: stats.nodeCount ?? 0, edges: stats.edgeCount ?? 0 },
    };
  };
}

describe("commit-pinned CodeGraph history", () => {
  it("retains and queries two real indexed revisions through the normal Knowledge route", async () => {
    const git = simpleGit(sourceRepo);
    await git.raw(["init", "--initial-branch", "main"]);
    await git.raw(["config", "user.name", "CodeGraph History Test"]);
    await git.raw(["config", "user.email", "codegraph-history@example.invalid"]);
    await writeOldRevision();
    const oldCommit = await commit("old revision");
    const service = new CodeGraphService({
      store,
      dataRoot,
      worker: createFixtureWorker(),
    });
    await service.sync("svc", "team", "cg-history");
    await service.onIdle("cg-history");
    expect(row.sync_error).toBeNull();
    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe(oldCommit.slice(0, 12));
    const oldLookup = findCodeGraphHistory(historyDir, oldCommit);
    expect(oldLookup.kind).toBe("ready");
    if (oldLookup.kind !== "ready") throw new Error("old historical snapshot was not ready");
    const oldTree = readHistoricalTree(oldLookup.snapshot);
    if (!oldTree) throw new Error("old historical tree was unavailable");
    expect(oldTree.size).toBeGreaterThanOrEqual(5);
    expect(oldTree.get("package.json")).toMatch(/^[0-9a-f]{40}$/);
    expect(oldTree.get("delete.ts")).toMatch(/^[0-9a-f]{40}$/);

    await writeNewRevision();
    const newCommit = await commit("new revision with add modify delete rename");
    await service.sync("svc", "team", "cg-history");
    await service.onIdle("cg-history");
    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe(newCommit.slice(0, 12));

    const oldResult = (await request("graph-search", { commit: oldCommit, query: "", limit: 100 })).body.data;
    const newResult = (await request("graph-search", { commit: newCommit, query: "", limit: 100 })).body.data;
    expect(oldResult.state).toBe("ready");
    expect(newResult.state).toBe("ready");
    expect(oldResult.commit).toBe(oldCommit);
    expect(newResult.commit).toBe(newCommit);
    expect(oldResult.indexVersion).not.toBe(newResult.indexVersion);

    const deleted = findSymbol(oldResult, "deletedSymbol");
    expect(deleted?.filePath).toBe("delete.ts");
    expect(findSymbol(newResult, "deletedSymbol")).toBeUndefined();
    const deletedSource = (await request("graph-source", { commit: oldCommit, nodeId: deleted!.id, indexVersion: oldResult.indexVersion! })).body.data;
    expect(deletedSource.source?.content).toContain("only in old revision");

    const added = findSymbol(newResult, "addedSymbol");
    expect(added?.filePath).toBe("added.ts");
    expect(findSymbol(oldResult, "addedSymbol")).toBeUndefined();
    const addedSource = (await request("graph-source", { commit: newCommit, nodeId: added!.id, indexVersion: newResult.indexVersion! })).body.data;
    expect(addedSource.source?.content).toContain("only in new revision");

    const oldModified = findSymbol(oldResult, "modifiedSymbol")!;
    const newModified = findSymbol(newResult, "modifiedSymbol")!;
    expect(oldModified.id).not.toBe(newModified.id);
    const oldModifiedSource = (await request("graph-source", { commit: oldCommit, nodeId: oldModified.id, indexVersion: oldResult.indexVersion! })).body.data;
    const newModifiedSource = (await request("graph-source", { commit: newCommit, nodeId: newModified.id, indexVersion: newResult.indexVersion! })).body.data;
    expect(oldModifiedSource.source?.content).toContain("old body");
    expect(newModifiedSource.source?.content).toContain("new body");

    expect(findSymbol(oldResult, "renamedSymbol")?.filePath).toBe("rename-old.ts");
    expect(findSymbol(newResult, "renamedSymbol")?.filePath).toBe("rename-new.ts");
    expect(findSymbol(oldResult, "uncertainSymbol")?.filePath).toBe("uncertain-old.ts");
    expect(findSymbol(newResult, "uncertainSymbol")?.filePath).toBe("uncertain-new.ts");

    const expired = (await request("graph-search", { commit: oldCommit, indexVersion: "not-the-index-version" })).body.data;
    expect(expired.state).toBe("version_expired");
    expect(expired.warnings).toEqual(["index_version_changed"]);

    await service.sync("svc", "team", "cg-history");
    await service.onIdle("cg-history");
    const prefixed = (await request("graph-search", { commit: newCommit.slice(0, 7), query: "", limit: 100 })).body.data;
    expect(prefixed.state).toBe("ready");
    expect(prefixed.commit).toBe(newCommit);
    const prefixedLookup = findCodeGraphHistory(historyDir, newCommit.slice(0, 7));
    expect(prefixedLookup.kind).toBe("ready");
    if (prefixedLookup.kind !== "ready") throw new Error("prefixed lookup was not ready");
    expect(prefixedLookup.snapshot.version).toBe(3);

    const missing = (await request("graph-search", { commit: "0123456789abcdef0123456789abcdef01234567" })).body.data;
    expect(missing.state).toBe("not_found");
    expect(missing.warnings).toEqual(["historical_snapshot_not_found"]);

    unlinkSync(join(historyDir, `${oldCommit}-v1`, "delete.ts"));
    const unavailable = (await request("graph-source", { commit: oldCommit, nodeId: deleted!.id, indexVersion: oldResult.indexVersion! })).body.data;
    expect(unavailable.state).toBe("source_unavailable");
    expect(unavailable.warnings).toEqual(["source_read_failed"]);
  }, 240_000);

  it("rejects indexed dirty bytes that differ from the commit tree", async () => {
    const git = simpleGit(sourceRepo);
    await git.raw(["init", "--initial-branch", "main"]);
    await git.raw(["config", "user.name", "CodeGraph History Test"]);
    await git.raw(["config", "user.email", "codegraph-history@example.invalid"]);
    writeFileSync(join(sourceRepo, "dirty.ts"), "export function cleanSymbol() {\n  return 'committed body';\n}\n");
    const commitHash = await commit("clean revision");
    mkdirSync(join(assetDir, ".."), { recursive: true });
    await simpleGit().clone(sourceRepo, assetDir, { "--depth": 1, "--branch": "main" });
    writeFileSync(join(assetDir, "dirty.ts"), "export function cleanSymbol() {\n  return 'dirty body';\n}\n");
    const instance = await indexProject(assetDir);
    closeIndex(instance);

    await expect(captureCodeGraphHistory({
      assetDir,
      branch: "main",
      version: 1,
      indexedAt: new Date().toISOString(),
      shortCommit: commitHash.slice(0, 12),
    })).rejects.toThrow("commit tree blob mismatch: dirty.ts");
  });

  it("returns null for legacy and unavailable historical trees", () => {
    const commit = "a".repeat(40);
    const legacyRoot = join(historyDir, `${commit}-v1`);
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "manifest.json"), JSON.stringify({
      schema: 1,
      commit,
      version: 1,
      indexedAt: "2026-11-25T00:00:00.000Z",
      branch: "main",
      sdkVersion: "1.6.2",
      fileCount: 0,
    }));
    expect(readHistoricalTree({
      commit,
      version: 1,
      indexedAt: "2026-11-25T00:00:00.000Z",
      branch: "main",
      sdkVersion: "1.6.2",
      root: legacyRoot,
      databasePath: join(legacyRoot, ".codegraph", "codegraph.db"),
    })).toBeNull();

    const unavailableRoot = join(historyDir, `${commit}-v2`);
    mkdirSync(unavailableRoot, { recursive: true });
    writeFileSync(join(unavailableRoot, "manifest.json"), JSON.stringify({
      schema: 2,
      commit,
      version: 2,
      indexedAt: "2026-11-25T00:00:00.000Z",
      branch: "main",
      sdkVersion: "1.6.2",
      fileCount: 0,
      treeFile: "tree.json",
      treeEntryCount: 0,
      treeSha256: "0".repeat(64),
    }));
    expect(readHistoricalTree({
      commit,
      version: 2,
      indexedAt: "2026-11-25T00:00:00.000Z",
      branch: "main",
      sdkVersion: "1.6.2",
      root: unavailableRoot,
      databasePath: join(unavailableRoot, ".codegraph", "codegraph.db"),
    })).toBeNull();

    const incompleteCommit = "b".repeat(40);
    const incompleteRoot = join(historyDir, `${incompleteCommit}-v1`);
    mkdirSync(incompleteRoot, { recursive: true });
    writeFileSync(join(incompleteRoot, "manifest.json"), JSON.stringify({
      schema: 2,
      commit: incompleteCommit,
      version: 1,
      indexedAt: "2026-11-25T00:00:00.000Z",
      branch: "main",
      sdkVersion: "1.6.2",
      fileCount: 0,
      treeFile: "tree.json",
      treeEntryCount: 0,
      treeSha256: "0".repeat(64),
    }));
    expect(findCodeGraphHistory(historyDir, incompleteCommit)).toEqual({
      kind: "expired",
      reason: "snapshot_incomplete",
    });
  });
});
