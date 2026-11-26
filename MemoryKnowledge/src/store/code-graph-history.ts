import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import simpleGit from "simple-git";
import { structuredSdkInfo } from "../engines/code/bridge.js";

const COMMIT_PREFIX_RE = /^[0-9a-f]{7,40}$/;
const SNAPSHOT_RE = /^([0-9a-f]{40})-v(\d+)$/;
const DATABASE_PATH = join(".codegraph", "codegraph.db");
const TREE_FILE = "tree.json";

export interface HistoricalCodeGraphSnapshot {
  commit: string;
  version: number;
  indexedAt: string;
  branch: string;
  sdkVersion: string;
  root: string;
  databasePath: string;
}

interface HistoricalSnapshotManifestBase {
  commit: string;
  version: number;
  indexedAt: string;
  branch: string;
  sdkVersion: string;
  fileCount: number;
}

interface HistoricalSnapshotManifestV1 extends HistoricalSnapshotManifestBase {
  schema: 1;
}

interface HistoricalSnapshotManifestV2 extends HistoricalSnapshotManifestBase {
  schema: 2;
  treeFile: "tree.json";
  treeEntryCount: number;
  treeSha256: string;
}

type HistoricalSnapshotManifest = HistoricalSnapshotManifestV1 | HistoricalSnapshotManifestV2;

export type HistoricalSnapshotLookup =
  | { kind: "ready"; snapshot: HistoricalCodeGraphSnapshot }
  | { kind: "not_found" }
  | { kind: "ambiguous" }
  | { kind: "expired"; reason: "manifest_invalid" | "snapshot_incomplete" };

export function isValidCommit(value: unknown): value is string {
  return typeof value === "string" && COMMIT_PREFIX_RE.test(value.toLowerCase());
}

function historyRoot(assetDir: string): string {
  return `${assetDir}.history`;
}

function snapshotDir(historyDir: string, commit: string, version: number): string {
  return join(historyDir, `${commit}-v${version}`);
}

async function fullHeadCommit(assetDir: string): Promise<string | null> {
  if (!existsSync(join(assetDir, ".git"))) return null;
  try {
    const commit = (await simpleGit(assetDir).revparse(["HEAD"])).trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function safeIndexedFile(root: string, filePath: string): string | null {
  if (!filePath || isAbsolute(filePath) || filePath.includes("\0")) return null;
  const path = resolve(root, filePath);
  const pathStat = lstatSync(path);
  if (pathStat.isSymbolicLink()) return null;
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const relativePath = relative(realRoot, realPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null;
  }
  const stat = lstatSync(realPath);
  return stat.isFile() && !stat.isSymbolicLink() ? realPath : null;
}

function verifyCopiedSource(path: string, buffer: Buffer, file: { path: string; content_hash: string }, blob: string) {
  const fd = openSync(path, "r");
  try {
    const indexed = createHash("sha256");
    const git = createHash("sha1").update(`blob ${statSync(path).size}\0`);
    let count: number;
    do {
      count = readSync(fd, buffer, 0, buffer.length, null);
      const bytes = buffer.subarray(0, count);
      indexed.update(bytes);
      git.update(bytes);
    } while (count === buffer.length);
    if (indexed.digest("hex") !== file.content_hash) throw new Error(`indexed source changed before historical capture: ${file.path}`);
    if (git.digest("hex") !== blob) throw new Error(`commit tree blob mismatch: ${file.path}`);
  } finally {
    closeSync(fd);
  }
}

function manifestPath(root: string): string {
  return join(root, "manifest.json");
}

function parseManifest(root: string): HistoricalSnapshotManifest | null {
  const path = manifestPath(root);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      (record.schema !== 1 && record.schema !== 2) ||
      typeof record.commit !== "string" ||
      !/^[0-9a-f]{40}$/.test(record.commit) ||
      typeof record.version !== "number" ||
      record.version < 1 ||
      typeof record.indexedAt !== "string" ||
      typeof record.branch !== "string" ||
      typeof record.sdkVersion !== "string" ||
      typeof record.fileCount !== "number" ||
      record.fileCount < 0
    ) {
      return null;
    }
    if (record.schema === 2) {
      if (
        record.treeFile !== TREE_FILE ||
        typeof record.treeEntryCount !== "number" ||
        !Number.isSafeInteger(record.treeEntryCount) ||
        record.treeEntryCount < 0 ||
        typeof record.treeSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(record.treeSha256)
      ) {
        return null;
      }
      return {
        schema: 2,
        commit: record.commit.toLowerCase(),
        version: record.version,
        indexedAt: record.indexedAt,
        branch: record.branch,
        sdkVersion: record.sdkVersion,
        fileCount: record.fileCount,
        treeFile: TREE_FILE,
        treeEntryCount: record.treeEntryCount,
        treeSha256: record.treeSha256,
      };
    }
    return {
      schema: 1,
      commit: record.commit.toLowerCase(),
      version: record.version,
      indexedAt: record.indexedAt,
      branch: record.branch,
      sdkVersion: record.sdkVersion,
      fileCount: record.fileCount,
    };
  } catch {
    return null;
  }
}

function toSnapshot(root: string, manifest: HistoricalSnapshotManifest): HistoricalCodeGraphSnapshot {
  return {
    commit: manifest.commit,
    version: manifest.version,
    indexedAt: manifest.indexedAt,
    branch: manifest.branch,
    sdkVersion: manifest.sdkVersion,
    root,
    databasePath: join(root, DATABASE_PATH),
  };
}

async function commitTree(assetDir: string, commit: string): Promise<Map<string, string>> {
  const output = await simpleGit(assetDir).raw(["ls-tree", "-rz", "-r", "--full-tree", commit]);
  const tree = new Map<string, string>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("invalid git tree entry");
    const [mode, type, object] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (!mode || !type || !object || !/^[0-9a-f]{40}$/.test(object) || !path || tree.has(path)) {
      throw new Error("invalid git tree entry");
    }
    if (type === "commit") continue;
    if (type !== "blob") throw new Error("invalid git tree entry");
    tree.set(path, object.toLowerCase());
  }
  return tree;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function serializeGitTree(tree: Map<string, string>): string {
  const entries = [...tree].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

export function readHistoricalTree(snapshot: HistoricalCodeGraphSnapshot): Map<string, string> | null {
  const manifest = parseManifest(snapshot.root);
  if (!manifest || manifest.schema !== 2) return null;
  const path = join(snapshot.root, TREE_FILE);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  try {
    const content = readFileSync(path, "utf8");
    if (createHash("sha256").update(content).digest("hex") !== manifest.treeSha256) return null;
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const tree = new Map<string, string>();
    for (const [filePath, blob] of Object.entries(value)) {
      if (!filePath || typeof blob !== "string" || !/^[0-9a-f]{40}$/.test(blob)) return null;
      tree.set(filePath, blob);
    }
    if (tree.size !== manifest.treeEntryCount) return null;
    return tree;
  } catch {
    return null;
  }
}

export async function captureCodeGraphHistory(input: {
  assetDir: string;
  branch: string;
  version: number;
  indexedAt: string;
  shortCommit?: string | null;
}): Promise<HistoricalCodeGraphSnapshot | null> {
  const commit = await fullHeadCommit(input.assetDir);
  if (!commit) return null;
  if (input.shortCommit && !commit.startsWith(input.shortCommit.toLowerCase())) {
    throw new Error("indexed commit does not match repository HEAD");
  }

  const historyDir = historyRoot(input.assetDir);
  const destination = snapshotDir(historyDir, commit, input.version);
  if (existsSync(destination)) {
    const existing = parseManifest(destination);
    if (existing) return toSnapshot(destination, existing);
    rmSync(destination, { recursive: true, force: true });
  }

  const sdk = await structuredSdkInfo(input.assetDir);
  const temporary = join(historyDir, `.tmp-${commit}-${randomUUID()}`);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(join(temporary, ".codegraph"), { recursive: true });
  const databasePath = join(temporary, DATABASE_PATH);

  let manifest: HistoricalSnapshotManifest;
  try {
    const gitTree = await commitTree(input.assetDir, commit);
    const source = new Database(sdk.databasePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(databasePath);
    } finally {
      source.close();
    }

    const snapshotDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const files = snapshotDatabase
        .prepare("SELECT path, content_hash FROM files ORDER BY path")
        .all() as { path: string; content_hash: string }[];
      const verificationBuffer = Buffer.alloc(64 * 1024);
      for (const file of files) {
        const sourcePath = safeIndexedFile(input.assetDir, file.path);
        const gitBlob = gitTree.get(file.path);
        if (!sourcePath || !gitBlob) {
          throw new Error(`indexed source changed before historical capture: ${file.path}`);
        }
        const destinationPath = join(temporary, file.path);
        mkdirSync(resolve(destinationPath, ".."), { recursive: true });
        copyFileSync(sourcePath, destinationPath);
        verifyCopiedSource(destinationPath, verificationBuffer, file, gitBlob);
      }
      const serializedTree = serializeGitTree(gitTree);
      writeFileSync(join(temporary, TREE_FILE), serializedTree);
      manifest = {
        schema: 2,
        commit,
        version: input.version,
        indexedAt: input.indexedAt,
        branch: input.branch,
        sdkVersion: sdk.version,
        fileCount: files.length,
        treeFile: TREE_FILE,
        treeEntryCount: gitTree.size,
        treeSha256: createHash("sha256").update(serializedTree).digest("hex"),
      };
      writeFileSync(manifestPath(temporary), `${JSON.stringify(manifest, null, 2)}\n`);
    } finally {
      snapshotDatabase.close();
    }

    mkdirSync(historyRoot(input.assetDir), { recursive: true });
    renameSync(temporary, destination);
    return toSnapshot(destination, manifest);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function findCodeGraphHistory(historyDir: string, commit: string): HistoricalSnapshotLookup {
  if (!isValidCommit(commit)) return { kind: "not_found" };
  const root = historyDir;
  if (!existsSync(root)) return { kind: "not_found" };

  const wanted = commit.toLowerCase();
  const matches: { snapshot: HistoricalCodeGraphSnapshot; version: number }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const match = SNAPSHOT_RE.exec(entry.name);
    if (!entry.isDirectory() || !match || !match[1].startsWith(wanted)) continue;
    const snapshotRoot = join(root, entry.name);
    const manifest = parseManifest(snapshotRoot);
    if (!manifest || manifest.commit !== match[1] || manifest.version !== Number(match[2])) {
      return { kind: "expired", reason: "manifest_invalid" };
    }
    const treeRequired = manifest.schema === 2;
    if (
      !isRegularFile(manifestPath(snapshotRoot)) ||
      !isRegularFile(join(snapshotRoot, DATABASE_PATH)) ||
      (treeRequired && !isRegularFile(join(snapshotRoot, TREE_FILE)))
    ) {
      return { kind: "expired", reason: "snapshot_incomplete" };
    }
    matches.push({ snapshot: toSnapshot(snapshotRoot, manifest), version: manifest.version });
  }
  if (matches.length === 0) return { kind: "not_found" };
  if (new Set(matches.map(match => match.snapshot.commit)).size > 1 && !/^[0-9a-f]{40}$/.test(wanted)) {
    return { kind: "ambiguous" };
  }
  matches.sort((left, right) => right.version - left.version);
  return { kind: "ready", snapshot: matches[0].snapshot };
}
