/**
 * Connection-only fingerprint shared with MemoryCore's enable gate.
 *
 * MemoryCore (`MemoryCore/src/metadata/service/model-config-fingerprint.ts`)
 * owns the authoritative implementation: it hashes provider + normalized base
 * URL + model id + a truncated SHA-256 digest of the API key. Knowledge Service
 * must not depend on MemoryCore sources (separate deployable), so the algorithm
 * is mirrored here and pinned by a fixed-vector test.
 *
 * Deliberately excludes version / description / instance: editing a remark must
 * not invalidate a successful probe, while every connection-field change must.
 */
import { createHash } from "node:crypto";

export interface ModelConfigFingerprintInput {
  provider: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export function modelConfigFingerprint(input: ModelConfigFingerprintInput): string {
  const keyDigest = createHash("sha256")
    .update(input.apiKey)
    .digest("hex")
    .slice(0, 16);
  const material = [
    input.provider,
    input.baseUrl.replace(/\/+$/, ""),
    input.modelId,
    keyDigest,
  ].join("\n");
  return `sha256:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

/** Shape check for fingerprints received from the control plane. */
export function isModelConfigFingerprint(value: string): boolean {
  return /^sha256:[0-9a-f]{16}$/.test(value);
}
