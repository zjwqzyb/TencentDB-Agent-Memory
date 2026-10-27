/**
 * Single resolution point for the managed model snapshot.
 *
 * Callers ask for a snapshot ONCE per background job and keep the returned
 * frozen object for the whole job. There is deliberately no cache here: the
 * metadata layer is the source of truth, and every job must observe an
 * enable/disable/version change at its own start.
 *
 * Fallback boundary (important):
 *   - No managed extraction configuration has EVER been activated for this
 *     instance → `resolveForJob()` returns `null`; the caller keeps the
 *     deployment default (`cfg.llm` / host runner). This is a deployment
 *     default, not a fallback.
 *   - A managed configuration exists but is paused / invalid / unreadable →
 *     throws `ModelSnapshotError`; the caller MUST NOT touch the global
 *     upstream.
 */

import { sanitizeEndpoint } from "./endpoint.js";
import {
  ModelSnapshotError,
  type ActiveModelSnapshot,
  type ModelJobType,
  type ModelSnapshotSource,
  type RawSnapshotResolution,
} from "./types.js";

export interface ModelSnapshotLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface ModelSnapshotResolverOptions {
  /** Instance this resolver belongs to (used for diagnostics only). */
  instanceId?: string;
  source?: ModelSnapshotSource;
  logger?: ModelSnapshotLogger;
}

const TAG = "[model-snapshot]";

interface NormalizedSnapshot extends ActiveModelSnapshot {}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveVersion(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Validate + freeze the raw metadata payload. Returns null when any connection
 * field is missing, so the caller can map it to MODEL_SNAPSHOT_INVALID instead
 * of attempting a half-configured upstream call.
 */
export function normalizeActiveSnapshot(
  raw: RawSnapshotResolution | null | undefined,
): NormalizedSnapshot | null {
  if (!raw || raw.status !== "ready") return null;
  const snapshot = raw.snapshot as Record<string, unknown> | undefined;
  if (!snapshot) return null;

  const configId = asNonEmptyString(snapshot.snapshot_id);
  const version = asPositiveVersion(snapshot.version);
  const provider = asNonEmptyString(snapshot.provider);
  const baseUrl = asNonEmptyString(snapshot.base_url);
  const apiKey = asNonEmptyString(snapshot.api_key);
  const modelId = asNonEmptyString(snapshot.model_id);

  if (!configId || version === null || !provider || !baseUrl || !apiKey || !modelId) {
    return null;
  }

  return Object.freeze({
    configId,
    version,
    provider,
    protocol: "openai-chat" as const,
    baseUrl,
    apiKey,
    modelId,
  });
}

/** Structured, credential-free log line for snapshot resolution/usage. */
export function logModelSnapshot(
  logger: ModelSnapshotLogger | undefined,
  event: string,
  fields: {
    jobType?: ModelJobType;
    outcome: string;
    snapshot?: ActiveModelSnapshot | null;
    configId?: string;
    version?: number;
    provider?: string;
    modelId?: string;
    endpoint?: string;
    reason?: string;
    instanceId?: string;
  },
): void {
  if (!logger) return;
  const payload = {
    event,
    job_type: fields.jobType,
    outcome: fields.outcome,
    instance_id: fields.instanceId,
    config_id: fields.configId ?? fields.snapshot?.configId,
    version: fields.version ?? fields.snapshot?.version,
    provider: fields.provider ?? fields.snapshot?.provider,
    model: fields.modelId ?? fields.snapshot?.modelId,
    endpoint: sanitizeEndpoint(fields.endpoint ?? fields.snapshot?.baseUrl),
    reason: fields.reason,
  };
  const line = `${TAG} ${JSON.stringify(payload)}`;
  if (fields.outcome === "failed") logger.warn(line);
  else logger.info(line);
}

export class ModelSnapshotResolver {
  private readonly source?: ModelSnapshotSource;
  private readonly logger?: ModelSnapshotLogger;
  private readonly instanceId?: string;

  constructor(opts: ModelSnapshotResolverOptions = {}) {
    this.source = opts.source;
    this.logger = opts.logger;
    this.instanceId = opts.instanceId;
  }

  /**
   * Resolve the snapshot for exactly one job.
   *
   * @returns the frozen snapshot, or `null` when this instance never had a
   *          managed configuration (deployment default applies).
   * @throws  ModelSnapshotError when a managed configuration exists but cannot
   *          be used — callers must fail the job, never fall back.
   */
  async resolveForJob(jobType: ModelJobType): Promise<ActiveModelSnapshot | null> {
    if (!this.source || !this.source.resolveActiveSnapshot) {
      // Deployment without a metadata control plane (open-source standalone /
      // OpenClaw in-process). Managed config can never exist here.
      logModelSnapshot(this.logger, "model.snapshot.skipped", {
        jobType,
        outcome: "deployment_default",
        reason: "no_metadata_source",
        instanceId: this.instanceId,
      });
      return null;
    }

    let raw: RawSnapshotResolution;
    try {
      raw = await this.source.resolveActiveSnapshot();
    } catch (err) {
      const reason = err instanceof Error ? err.name : "unknown";
      logModelSnapshot(this.logger, "model.snapshot.failed", {
        jobType,
        outcome: "failed",
        reason: `read_error:${reason}`,
        instanceId: this.instanceId,
      });
      throw new ModelSnapshotError(
        "MODEL_SNAPSHOT_UNAVAILABLE",
        `managed model snapshot is unreadable for job "${jobType}"`,
        { jobType, reason: `read_error:${reason}` },
      );
    }

    const status = typeof raw?.status === "string" ? raw.status : "unknown";

    if (status === "ready") {
      const snapshot = normalizeActiveSnapshot(raw);
      if (!snapshot) {
        logModelSnapshot(this.logger, "model.snapshot.failed", {
          jobType,
          outcome: "failed",
          configId: asNonEmptyString((raw.snapshot as Record<string, unknown> | undefined)?.snapshot_id) ?? undefined,
          reason: "incomplete_ready_snapshot",
          instanceId: this.instanceId,
        });
        throw new ModelSnapshotError(
          "MODEL_SNAPSHOT_INVALID",
          `managed model snapshot is incomplete for job "${jobType}"`,
          { jobType, reason: "incomplete_ready_snapshot" },
        );
      }
      logModelSnapshot(this.logger, "model.snapshot.resolved", {
        jobType,
        outcome: "ready",
        snapshot,
        instanceId: this.instanceId,
      });
      return snapshot;
    }

    if (status === "paused") {
      logModelSnapshot(this.logger, "model.snapshot.failed", {
        jobType,
        outcome: "failed",
        reason: "paused",
        instanceId: this.instanceId,
      });
      throw new ModelSnapshotError(
        "MODEL_SNAPSHOT_PAUSED",
        `managed model configuration is paused; job "${jobType}" refused to run`,
        { jobType, reason: "paused" },
      );
    }

    if (status === "invalid") {
      const reason = typeof raw.reason === "string" ? raw.reason : "invalid";
      logModelSnapshot(this.logger, "model.snapshot.failed", {
        jobType,
        outcome: "failed",
        reason,
        instanceId: this.instanceId,
      });
      throw new ModelSnapshotError(
        "MODEL_SNAPSHOT_INVALID",
        `managed model configuration is invalid (${reason}); job "${jobType}" refused to run`,
        { jobType, reason },
      );
    }

    if (status === "config_unavailable") {
      // `config_unavailable` conflates "never configured" with "row exists but
      // has no active snapshot". Ask for the second signal when available so a
      // broken managed row can never masquerade as an unconfigured deployment.
      let managed = false;
      if (this.source.hasManagedConfiguration) {
        try {
          managed = await this.source.hasManagedConfiguration();
        } catch (err) {
          const reason = err instanceof Error ? err.name : "unknown";
          logModelSnapshot(this.logger, "model.snapshot.failed", {
            jobType,
            outcome: "failed",
            reason: `probe_error:${reason}`,
            instanceId: this.instanceId,
          });
          throw new ModelSnapshotError(
            "MODEL_SNAPSHOT_UNAVAILABLE",
            `cannot determine managed model state for job "${jobType}"`,
            { jobType, reason: `probe_error:${reason}` },
          );
        }
      }
      if (managed) {
        logModelSnapshot(this.logger, "model.snapshot.failed", {
          jobType,
          outcome: "failed",
          reason: "managed_row_without_active_snapshot",
          instanceId: this.instanceId,
        });
        throw new ModelSnapshotError(
          "MODEL_SNAPSHOT_UNAVAILABLE",
          `managed extraction row exists but has no active snapshot; job "${jobType}" refused to run`,
          { jobType, reason: "managed_row_without_active_snapshot" },
        );
      }
      logModelSnapshot(this.logger, "model.snapshot.skipped", {
        jobType,
        outcome: "deployment_default",
        reason: "never_configured",
        instanceId: this.instanceId,
      });
      return null;
    }

    logModelSnapshot(this.logger, "model.snapshot.failed", {
      jobType,
      outcome: "failed",
      reason: `unknown_status:${status}`,
      instanceId: this.instanceId,
    });
    throw new ModelSnapshotError(
      "MODEL_SNAPSHOT_UNAVAILABLE",
      `unexpected managed model state "${status}" for job "${jobType}"`,
      { jobType, reason: `unknown_status:${status}` },
    );
  }
}
