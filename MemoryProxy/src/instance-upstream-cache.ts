/**
 * Instance Upstream Config Cache — per-instance model-group config
 * fetched from Core `/v3/internal/meta/instance-upstream/list` (D 接口).
 *
 * Rewritten to v2 (model groups). See
 * docs/design/2026-08-25-instance-upstream-config.md §5 / §7.
 *
 * Cache semantics (与 v1 一致,只换数据结构):
 *   - Key: spaceId (one entry per instance, covering all groups + extraction)
 *   - TTL: 由 config.instanceUpstream.cacheTtlSec 决定(秒,默认 30),
 *          hard expiry,不 refresh-on-access
 *   - Stale-if-error: on fetch failure, return last known good value
 *   - First-time failure: return empty array (= 触发 resolveForAgent 零行 fallback,
 *     视为 official 全走全局 upstream + alias,与旧版行为一致)
 *   - Max entries: 256, evict oldest-written on overflow
 *
 * ## v1 → v2 API 迁移
 *
 * 老接口 `resolveUpstreamConfig(items, agentSource, type)` 拆成两个:
 *   - `resolveForAgent(items, agentSource)` → 对话请求 4 态解析(override/official/blocked/unmanaged)
 *   - `resolveExtraction(items)` → 抽取请求(返 null 表示"用全局",不产生 blocked)
 *
 * `shouldOverride` 保留,只对 kind=override 或 extraction 非 null 返 true;alias-skip 门统一走它。
 */

import type { CoreSkillConfig, InstanceUpstreamConfig } from "./types.js";

const TAG = "[instance-upstream-cache]";
const FALLBACK_TTL_SEC = 30; // 默认 30 秒
const MAX_ENTRIES = 256;

/**
 * 归一化 TTL(秒 → 毫秒)。只接受正整数;非法/负数/零/NaN/小数/undefined 一律回退默认 30s
 * + warn 一行,保证"默认不配 100% 向后兼容"红线([[default-no-config-backward-compat]])。
 * 每次 handler 调用都归一一次,可忽略开销。
 */
function normalizeTtlMs(rawSec: number | undefined): number {
  if (rawSec === undefined) return FALLBACK_TTL_SEC * 1000;
  if (!Number.isFinite(rawSec) || !Number.isInteger(rawSec) || rawSec <= 0) {
    console.warn(`${TAG} instanceUpstream.cacheTtlSec=${rawSec} 非法,回退默认 ${FALLBACK_TTL_SEC}s`);
    return FALLBACK_TTL_SEC * 1000;
  }
  return rawSec * 1000;
}

// ── Types (v2 模型组) ────────────────────────────────────────────────────

export type GroupType = "default" | "custom" | "extraction";
export type UpstreamMode = "official" | "custom_unified" | "custom_passthrough";

/** Core D 接口返回的每行(注意 api_key 是明文,仅内部接口才这样)。 */
export interface InstanceUpstreamRow {
  group_id: string;
  group_type: GroupType;
  name: string;
  agents: string[];
  enabled: boolean;
  mode: UpstreamMode;
  /** Provider preset (informational; present on real Core responses). */
  provider?: string;
  base_url: string;
  api_key: string;      // 内部接口拿到明文,供 Proxy 转发上游
  model_id: string;
  // ── Core 真实返回里还带的字段 ─────────────────────────────────────────────
  // Proxy 本身不消费它们, 但真实 API 返回里有, 测试 mock 也会填, 不写进类型
  // 会让任何按真实返回构造数据的测试 TS2353。
  /** DB 行主键, 调用方不消费 */
  id?: number;
  /** 该组的说明文字, 调用方不消费 */
  description?: string;
  /** 版本号, 用于 CAS 更新, Proxy 不消费 */
  version?: number;
  /** 组当时支持的 agent 全集快照（供 Panel 查老组对哪些 agent 生效）*/
  supported_agents_snapshot?: string[];
  created_at?: string;
  updated_at?: string;
}

/**
 * resolveForAgent 4 态返回:
 *   - override:  匹配到 custom.agents 且 enabled → 用该 row 的配置转发
 *   - official:  匹配到 default.agents 且 enabled(或 items 空的零行 fallback)→ 走全局 upstream + alias
 *   - blocked:   命中 default/custom 组但 enabled=false → 拒绝服务(UPSTREAM_DISABLED 400)
 *   - unmanaged: agent 既不在 default 也不在任何 custom → 拒绝服务(AGENT_NOT_CONFIGURED 400)
 */
export type Resolution =
  | { kind: "override"; row: InstanceUpstreamRow }
  | { kind: "official"; row: InstanceUpstreamRow | null }
  | { kind: "blocked"; reason: "default_disabled" | "custom_disabled"; group_id: string }
  | { kind: "unmanaged"; agent: string };

interface CacheEntry {
  items: InstanceUpstreamRow[];
  expiresAt: number;
  /** Unix ms of the successful fetch that produced this entry. */
  fetchedAt: number;
}

/**
 * Force-refresh coalescing window.
 *
 * `forceRefresh` bypasses the normal TTL so Panel enable/disable gestures are
 * observable on the next request. Two call sites in the same HTTP request
 * (early stage + passthrough) would otherwise each hit Core; entries younger
 * than this window are reused. Kept well under a second so it can never mask a
 * user-visible toggle for long.
 */
let forceRefreshWindowMs = 750;

/** Test-only: shrink/expand the force-refresh coalescing window. */
export function __setForceRefreshWindowForTests(ms: number): void {
  forceRefreshWindowMs = ms;
}

/**
 * Freshness of a lookup:
 *   - fresh:       the value came from Core in this call (or a live TTL entry)
 *   - stale:       Core could not be reached; `items` is the last known good value
 *   - unavailable: Core could not be reached AND no historic value exists
 *
 * Write-side (extraction) call sites must treat `stale`/`unavailable` as
 * "unknown", never as "not configured".
 */
export type InstanceUpstreamFreshness = "fresh" | "stale" | "unavailable";

export interface InstanceUpstreamState {
  items: InstanceUpstreamRow[];
  freshness: InstanceUpstreamFreshness;
  /** Unix ms of the last successful fetch (0 when never fetched). */
  fetchedAt: number;
  error?: string;
}

// ── Module state ─────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();
const lastGood = new Map<string, InstanceUpstreamRow[]>();
/** In-flight force-refresh dedupe (per instance) so bursty extraction calls share one read. */
const inFlightStates = new Map<string, Promise<InstanceUpstreamState>>();

// ── Fetch from Core ──────────────────────────────────────────────────────────

async function fetchFromCore(
  config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
): Promise<InstanceUpstreamRow[]> {
  const url = `${config.endpoint.replace(/\/$/, "")}/v3/internal/meta/instance-upstream/list`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.serviceToken}`,
      "x-tdai-service-id": spaceId,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(config.timeoutMs || 3000),
  });

  if (!resp.ok) {
    throw new Error(`${TAG} HTTP ${resp.status} from ${url}`);
  }

  const env = await resp.json() as { code?: number; data?: { items?: InstanceUpstreamRow[] } };
  if (env.code !== 0) {
    throw new Error(`${TAG} envelope error code=${env.code}`);
  }
  return env.data?.items ?? [];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all upstream config rows for an instance (cached, TTL 由 config 决定, stale-if-error).
 *
 * Returns empty array when:
 *   - Instance has no config AND Core seed 未触发(极端时序)
 *   - Core unreachable AND no prior cached value
 *
 * 空数组会被 resolveForAgent 视作"零行 fallback",走 official + 全局 upstream + alias
 * (与 v1 行为完全一致,保证配置系统挂时业务不中断)。
 *
 * 参数拆两个:
 *   - `skillConfig` 提供 D 接口的 endpoint / serviceToken / timeoutMs(共用 core gateway)
 *   - `cacheConfig` 提供缓存 TTL;整段可省(测试友好)/字段可缺(用默认 30s)
 */
export async function getInstanceUpstreamConfigs(
  skillConfig: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
  cacheConfig?: Partial<InstanceUpstreamConfig>,
): Promise<InstanceUpstreamRow[]> {
  const state = await getInstanceUpstreamConfigState(skillConfig, spaceId, cacheConfig);
  return state.items;
}

/**
 * Like {@link getInstanceUpstreamConfigs} but exposes freshness so the write
 * side can distinguish "not configured" from "could not read the config".
 *
 * `forceRefresh` bypasses the TTL cache (still dedupes concurrent callers and
 * still updates the last-known-good value). Extraction call sites use it so an
 * enable/disable in Panel takes effect on the very next request instead of
 * waiting out `cacheTtlSec`.
 */
export async function getInstanceUpstreamConfigState(
  skillConfig: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
  cacheConfig?: Partial<InstanceUpstreamConfig>,
  opts?: { forceRefresh?: boolean },
): Promise<InstanceUpstreamState> {
  if (!spaceId) {
    // Non-instance (legacy global) traffic: no instance config can exist.
    return { items: [], freshness: "fresh", fetchedAt: Date.now() };
  }

  const forceRefresh = opts?.forceRefresh === true;

  const cached = cache.get(spaceId);
  if (cached) {
    const now = Date.now();
    const ttlHit = !forceRefresh && cached.expiresAt > now;
    const coalesced = forceRefresh && now - cached.fetchedAt < forceRefreshWindowMs;
    if (ttlHit || coalesced) {
      return { items: cached.items, freshness: "fresh", fetchedAt: cached.fetchedAt };
    }
  }

  const pending = inFlightStates.get(spaceId);
  if (pending) {
    // A concurrent refresh is already in flight — reuse it instead of doubling
    // the Core load.
    return pending;
  }

  const run = (async (): Promise<InstanceUpstreamState> => {
    let fresh: InstanceUpstreamRow[] | null = null;
    let fetchErr: unknown = null;
    try {
      fresh = await fetchFromCore(skillConfig, spaceId);
    } catch (err) {
      fetchErr = err;
    }

    if (fresh !== null) {
      evictIfNeeded();
      const ttlMs = normalizeTtlMs(cacheConfig?.cacheTtlSec);
      const fetchedAt = Date.now();
      cache.set(spaceId, { items: fresh, expiresAt: fetchedAt + ttlMs, fetchedAt });
      lastGood.set(spaceId, fresh);
      return { items: fresh, freshness: "fresh", fetchedAt: Date.now() };
    }

    const error = fetchErr instanceof Error ? fetchErr.message : String(fetchErr ?? "unknown");
    const stale = lastGood.get(spaceId);
    if (stale !== undefined) {
      console.warn(`${TAG} stale-if-error for spaceId=${spaceId} (reason: ${error})`);
      return { items: stale, freshness: "stale", fetchedAt: 0, error };
    }

    console.warn(`${TAG} fetch failed for spaceId=${spaceId}, no stale fallback: ${error}`);
    return { items: [], freshness: "unavailable", fetchedAt: 0, error };
  })();

  inFlightStates.set(spaceId, run);
  void run
    .catch(() => undefined)
    .finally(() => {
      if (inFlightStates.get(spaceId) === run) inFlightStates.delete(spaceId);
    });

  return run;
}

/**
 * Drop the cached config for one instance. Used by admin mutation paths (and
 * tests) so an enable/disable is observable immediately.
 */
export function invalidateInstanceUpstreamConfigs(spaceId: string): void {
  cache.delete(spaceId);
  inFlightStates.delete(spaceId);
}

/**
 * 对话请求解析:输入 items 数组 + agent,输出 4 态 Resolution。
 *
 * 详见 §7.3。**关键**:items 为空数组时返回 `{kind:"official", row:null}`,
 * handler 见到 row=null 一律按"走全局 upstream + alias"处理 —— 这是"向后兼容"
 * 红线的直接体现([[default-no-config-backward-compat]]):Core 挂 / seed 失败 /
 * stale 缓存首次没命中时,业务侧行为等同 v1,不会因为本功能返 500。
 */
export function resolveForAgent(
  items: InstanceUpstreamRow[],
  agentSource: string,
): Resolution {
  // 只关心 conversation 用的组行(default + custom),忽略 extraction 行
  const convRows = items.filter(
    (r) => r.group_type === "default" || r.group_type === "custom",
  );

  // 0. 零行 fallback:向后兼容红线保护
  if (convRows.length === 0) {
    return { kind: "official", row: null };
  }

  // 1. 找显式覆盖该 agent 的 custom 组
  const custom = convRows.find(
    (r) => r.group_type === "custom" && r.agents.includes(agentSource),
  );
  if (custom) {
    if (!custom.enabled) {
      return { kind: "blocked", reason: "custom_disabled", group_id: custom.group_id };
    }
    return { kind: "override", row: custom };
  }

  // 2. 找显式覆盖该 agent 的 default 组
  const def = convRows.find(
    (r) => r.group_type === "default" && r.agents.includes(agentSource),
  );
  if (def) {
    if (!def.enabled) {
      return { kind: "blocked", reason: "default_disabled", group_id: def.group_id };
    }
    return { kind: "official", row: def };
  }

  // 3. agent 不在任何组的 agents 列表里 → unmanaged(管理员主动不给 upstream)
  return { kind: "unmanaged", agent: agentSource };
}

/**
 * @deprecated Legacy extraction lookup. DO NOT use on the write side.
 *
 * It silently maps disabled/incomplete rows to `null` (= "use the global
 * upstream"), which is exactly the fallback the managed-model gate forbids.
 * Use {@link getInstanceUpstreamConfigState} + `evaluateExtractionUpstream`
 * instead; they distinguish "never configured" from "paused / incomplete /
 * unreadable".
 */
export function resolveExtraction(
  items: InstanceUpstreamRow[],
): InstanceUpstreamRow | null {
  const ext = items.find((r) => r.group_type === "extraction");
  if (!ext || !ext.enabled || !ext.base_url) return null;
  return ext;
}

/**
 * 判断该 resolution 是否属于"用户自定义 upstream"(需要跳过 alias 翻译 + 不上报 credit)。
 *
 * 用于 handler 的 alias-skip 门(§7.5,承接 1b33b03f 的 caller-dispatch):
 *   - 对话请求:传入 resolveForAgent 的结果,只有 kind=override 返 true
 *   - 抽取请求:传入 resolveExtraction 的结果,只有非 null 返 true(等价于"已配 + enabled + base_url 非空")
 */
export function shouldOverride(
  x: Resolution | InstanceUpstreamRow | null,
): x is InstanceUpstreamRow | Extract<Resolution, { kind: "override" }> {
  if (x === null) return false;
  if ("kind" in x) return x.kind === "override";
  // 已经是 row(resolveExtraction 的返回)
  return true;
}

// ── Internals ────────────────────────────────────────────────────────────────

function evictIfNeeded(): void {
  if (cache.size < MAX_ENTRIES) return;
  // Evict oldest-written entry (first key in insertion-order Map)
  const oldestKey = cache.keys().next().value as string | undefined;
  if (oldestKey) {
    cache.delete(oldestKey);
    // Keep lastGood for stale-if-error — only remove from TTL cache
  }
}

/** Clear all cache (for testing). */
export function clearCache(): void {
  cache.clear();
  lastGood.clear();
}

/**
 * 测试专用:直接把 items 写进 cache,让 handler 命中 override / extraction 场景
 * 而不需要跑起真 Core mock。ttlMs 默认 60s,足够单测生命周期。
 */
export function __primeCacheForTests(spaceId: string, items: InstanceUpstreamRow[], ttlMs = 60_000): void {
  const now = Date.now();
  cache.set(spaceId, { items, expiresAt: now + ttlMs, fetchedAt: now });
  lastGood.set(spaceId, items);
}
