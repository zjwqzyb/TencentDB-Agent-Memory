/**
 * extraction-gate — the single semantic gate for every write-side
 * (extraction) call site.
 *
 * Motivation:
 *   The read side (injection) has a first-class pipeline + hook registry +
 *   yaml whitelist (`injection.injectors: [...]`). The write side
 *   historically had none — `triggerSkillExtractIfReady` and
 *   `recordTdaiTurn` were sprinkled across handler.ts / anthropicHandler.ts
 *   and had no top-level kill switch. Operators could not "inject but not
 *   extract" without touching source dependencies.
 *
 * Design (intentionally minimal — keep the stable version stable):
 *   - Add ONE yaml section: `extraction: { enabled, extractors: [...] }`.
 *   - Add ONE pure predicate: `isExtractionAllowed(config, asset)`.
 *   - Wrap each existing call site in `if (isExtractionAllowed(...))`.
 *
 * Backwards compatibility is preserved by making the gate PERMISSIVE when
 * the config section is missing or malformed:
 *   - `config.extraction` absent          → allow all (defensive fallback)
 *   - `extractors` field missing          → allow all (partial config)
 *   - `extractors` not an array           → allow all (yaml typo tolerance)
 *   - `enabled: false`                    → deny everything
 *   - `extractors: []`                    → deny everything
 *   - `extractors: ["skill"]`             → allow only "skill"
 *
 * Adding a new extractor asset later means: register it under a stable name
 * here and add one `if (isExtractionAllowed(config, "your-asset"))` at the
 * new call site. No pipeline refactor required.
 */

import { log } from "./report/log.js";
import type { ProxyConfig } from "./types.js";
import type { InstanceUpstreamRow, InstanceUpstreamState } from "./instance-upstream-cache.js";

export function isExtractionAllowed(config: ProxyConfig, asset: string): boolean {
  const ext = config.extraction;
  // Defensive: missing extraction block → keep historical "always on" behavior.
  if (!ext) return true;
  if (ext.enabled === false) return false;
  // Defensive: missing / non-array extractors → treat as unrestricted whitelist
  // so a partial or misconfigured yaml never silently disables writes.
  if (!Array.isArray(ext.extractors)) return true;
  return ext.extractors.includes(asset);
}

/**
 * Emit a structured debug event when the gate blocks an extraction call.
 * Call this in the *else* branch of `isExtractionAllowed`. No-ops when the
 * asset would have been allowed anyway (defensive: prevents misleading
 * "skipped" events if a caller forgets the surrounding `if`).
 *
 * Level rationale: emitted at DEBUG level (not INFO) because it fires on
 * every turn once extraction is off and would swamp production log volume.
 * Flip `log.level=debug` when investigating "why isn't extract running?".
 */
export function logExtractionSkipped(
  config: ProxyConfig,
  asset: string,
  sessionKey: string | undefined,
): void {
  // If this asset is actually allowed, do NOT emit a skip event — that would
  // be a lie. This makes the function safe to call unconditionally next to
  // an `if (!isExtractionAllowed(...))` guard without worrying about drift.
  if (isExtractionAllowed(config, asset)) return;

  const ext = config.extraction;
  const reason =
    !ext ? "no-config"                          // won't happen (allowed path)
    : ext.enabled === false ? "disabled"        // extraction.enabled=false
    : "not-in-extractors";                      // asset missing from whitelist
  const session = sessionKey && sessionKey.length > 0 ? sessionKey : "-";
  log.debug("extraction.skipped", { asset, session, reason });
}

// ============================================================
// Managed extraction model (Panel-configured snapshot)
// ============================================================
//
// The Panel manages ONE extraction model per Memory Instance. Proxy is the
// write-side boundary: every system-user (memory/skill extraction) request must
// either use that managed model or fail closed.
//
// Semantic contract:
//   - unconfigured : no extraction row ever existed → deployment default
//                    (global upstream) applies. This is the unchanged
//                    open-source behaviour.
//   - managed      : enabled + endpoint + key + model all present → forward.
//   - paused       : a previously active configuration was disabled → refuse.
//   - incomplete   : enabled but one of endpoint/key/model is missing → refuse.
//   - unavailable  : the config could not be read (or only a stale copy
//                    exists) → refuse; NEVER treat as "unconfigured".
//
// `enabled===true` is required in addition to the connection fields, and the
// model id is mandatory: forwarding without it would let the upstream pick an
// arbitrary default model, which is exactly the silent fallback this ticket
// forbids.

export type ExtractionUpstreamDecision =
  | { kind: "managed"; row: InstanceUpstreamRow }
  | { kind: "unconfigured"; reason: string }
  | { kind: "paused"; row: InstanceUpstreamRow }
  | { kind: "incomplete"; row: InstanceUpstreamRow; missing: string[] }
  | { kind: "unavailable"; reason: string };

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Origin + path only (no userinfo/query/hash) — safe for logs. */
export function sanitizeUpstreamEndpoint(raw: string | undefined | null): string {
  if (!raw) return "(none)";
  try {
    const url = new URL(raw.trim());
    const path = url.pathname.replace(/\/+$/, "");
    const out = `${url.protocol}//${url.host}${path}`;
    return out.length > 120 ? `${out.slice(0, 117)}...` : out;
  } catch {
    const fallback = raw.trim().split(/[?#]/)[0] ?? "";
    return fallback.slice(0, 80) || "(invalid)";
  }
}

/**
 * Decide what the write side should do with the instance's extraction row.
 * Pure: all I/O (including freshness) is supplied by the caller.
 */
export function evaluateExtractionUpstream(
  state: Pick<InstanceUpstreamState, "items" | "freshness">,
): ExtractionUpstreamDecision {
  if (state.freshness !== "fresh") {
    // Read failure must never degrade into "not configured": a stale copy may
    // predate a pause, so it is not trustworthy for the write side either.
    return { kind: "unavailable", reason: `config_${state.freshness}` };
  }

  const row = state.items.find((r) => r.group_type === "extraction");
  if (!row) return { kind: "unconfigured", reason: "no_extraction_row" };

  const baseUrl = nonEmpty(row.base_url);
  const apiKey = nonEmpty(row.api_key);
  const modelId = nonEmpty(row.model_id);
  const hasActive = baseUrl !== "" || apiKey !== "" || modelId !== "";

  if (row.enabled !== true) {
    // A draft-only row (never activated) has no active fields → still the
    // deployment default. A previously active row keeps its fields while
    // disabled (draft + snapshot retained) → paused, fail closed.
    return hasActive
      ? { kind: "paused", row }
      : { kind: "unconfigured", reason: "never_activated" };
  }

  const missing: string[] = [];
  if (!baseUrl) missing.push("base_url");
  if (!apiKey) missing.push("api_key");
  if (!modelId) missing.push("model_id");
  if (missing.length > 0) return { kind: "incomplete", row, missing };

  return { kind: "managed", row };
}

/** Stable machine-readable error code + HTTP status for a blocked decision. */
export function extractionDecisionError(
  decision: Exclude<ExtractionUpstreamDecision, { kind: "managed" } | { kind: "unconfigured" }>,
): { status: number; code: string; message: string; detail: Record<string, unknown> } {
  if (decision.kind === "paused") {
    return {
      status: 409,
      code: "EXTRACTION_MODEL_PAUSED",
      message: "The instance extraction model is paused. Enable a tested model configuration in Panel to resume background generation.",
      detail: { config_id: decision.row.group_id },
    };
  }
  if (decision.kind === "incomplete") {
    return {
      status: 409,
      code: "EXTRACTION_MODEL_INCOMPLETE",
      message: `The instance extraction model is incomplete (missing: ${decision.missing.join(", ")}).`,
      detail: { config_id: decision.row.group_id, missing: decision.missing },
    };
  }
  return {
    status: 503,
    code: "EXTRACTION_MODEL_UNAVAILABLE",
    message: "The instance extraction model configuration could not be read; refusing to fall back to the global upstream.",
    detail: { reason: decision.reason },
  };
}
