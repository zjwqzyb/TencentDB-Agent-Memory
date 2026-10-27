import { createHash, randomBytes } from "node:crypto";

export interface ModelConfigFingerprintInput {
  provider: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

/**
 * Connection-only fingerprint shared by the test recorder and enable gate.
 *
 * Deliberately excludes version / description / instance: editing a remark must
 * not invalidate a successful probe, while every connection-field change must.
 */
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

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate an immutable active-snapshot identifier in the documented
 * `snap_<ULID>` shape. A local ULID encoder avoids adding a runtime dependency
 * just for this identifier.
 */
export function newModelConfigSnapshotId(nowMs: number = Date.now()): string {
  let remaining = BigInt(nowMs);
  const time = new Array<string>(10);
  for (let i = time.length - 1; i >= 0; i -= 1) {
    time[i] = CROCKFORD_BASE32[Number(remaining % 32n)];
    remaining /= 32n;
  }

  const random = randomBytes(16);
  let randomness = "";
  for (const byte of random) {
    randomness += CROCKFORD_BASE32[byte & 31];
  }
  return `snap_${time.join("")}${randomness}`;
}
