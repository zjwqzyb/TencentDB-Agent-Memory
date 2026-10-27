/**
 * Model snapshot — the immutable, job-scoped view of the managed
 * (Panel-configured) extraction model.
 *
 * Why this exists
 * ---------------
 * The Panel lets a system_admin configure one extraction/back-end model per
 * Memory Instance (GLM / DeepSeek / third-party OpenAI-compatible endpoint).
 * Once enabled, that configuration is frozen into an *active snapshot* by the
 * metadata layer (`resolveInstanceUpstreamExtractionSnapshot`).
 *
 * Every background generator (memory L1/L2/L3, Skill extraction) must use the
 * SAME endpoint/model/credential for its whole job:
 *   - resolve ONCE at job start,
 *   - reuse the frozen object for every upstream request in that job
 *     (tool loops included),
 *   - fail closed when the managed configuration is paused/invalid/unreadable
 *     instead of silently falling back to the global upstream.
 */

export type ModelJobType = "l1" | "l2" | "l3" | "skill";

/** Frozen, connection-ready model configuration for exactly one job. */
export interface ActiveModelSnapshot {
  /** Extraction group id (public DTO `config_id`). */
  readonly configId: string;
  /** Monotonic configuration version at activation time. */
  readonly version: number;
  /** Provider preset: "glm" | "deepseek" | "custom" | ... (informational). */
  readonly provider: string;
  /** Wire protocol. Only OpenAI Chat Completions is supported in phase 1. */
  readonly protocol: "openai-chat";
  readonly baseUrl: string;
  /** Plaintext credential — never log, never serialise. */
  readonly apiKey: string;
  readonly modelId: string;
}

/**
 * Raw shape returned by MetadataService.resolveInstanceUpstreamExtractionSnapshot.
 * Kept structural (Record) so this module does not import the metadata layer.
 */
export type RawSnapshotResolution = Record<string, unknown>;

export interface ModelSnapshotSource {
  /** Mirrors MetadataService.resolveInstanceUpstreamExtractionSnapshot(). */
  resolveActiveSnapshot(): Promise<RawSnapshotResolution>;
  /**
   * Optional second signal used to distinguish "this instance never had a
   * managed extraction configuration" (deployment default is fine) from
   * "a managed extraction row exists but cannot be resolved" (fail closed).
   */
  hasManagedConfiguration?(): Promise<boolean>;
}

export type ModelSnapshotErrorCode =
  | "MODEL_SNAPSHOT_PAUSED"
  | "MODEL_SNAPSHOT_INVALID"
  | "MODEL_SNAPSHOT_UNAVAILABLE";

export interface ModelSnapshotErrorDetails {
  jobType: ModelJobType;
  /** Present when the metadata layer reported a provider/version. */
  configId?: string;
  version?: number;
  provider?: string;
  modelId?: string;
  reason?: string;
}

/**
 * Fail-closed error raised instead of falling back to the global upstream.
 * `details` deliberately excludes the API key and the full request/response.
 */
export class ModelSnapshotError extends Error {
  readonly code: ModelSnapshotErrorCode;
  readonly details: ModelSnapshotErrorDetails;

  constructor(
    code: ModelSnapshotErrorCode,
    message: string,
    details: ModelSnapshotErrorDetails,
  ) {
    super(message);
    this.name = "ModelSnapshotError";
    this.code = code;
    this.details = details;
  }
}
