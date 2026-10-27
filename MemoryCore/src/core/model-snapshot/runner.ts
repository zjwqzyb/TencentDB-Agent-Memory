/**
 * Turn a frozen {@link ActiveModelSnapshot} into a concrete LLM runner.
 *
 * The runner is created ONCE per job; every upstream request the job makes
 * (including AI-SDK tool-call steps) goes through the same endpoint, model and
 * credential object.
 */

import { StandaloneLLMRunner } from "../../adapters/standalone/llm-runner.js";
import type { Logger } from "../types.js";
import type { ActiveModelSnapshot } from "./types.js";

export interface SnapshotRunnerOptions {
  enableTools: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  logger?: Logger;
}

/** Build the standalone runner config for a snapshot (no global cfg.llm fields). */
export function standaloneConfigFromSnapshot(
  snapshot: ActiveModelSnapshot,
  opts?: { maxTokens?: number; timeoutMs?: number },
): {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  stream: false;
} {
  return {
    baseUrl: snapshot.baseUrl,
    apiKey: snapshot.apiKey,
    model: snapshot.modelId,
    maxTokens: opts?.maxTokens ?? 4096,
    timeoutMs: opts?.timeoutMs ?? 120_000,
    // Managed compatible endpoints are used in non-streaming mode: it is the
    // historical default for this runner and avoids protocol quirks in
    // third-party "OpenAI-compatible" services.
    stream: false,
  };
}

export function createSnapshotLLMRunner(
  snapshot: ActiveModelSnapshot,
  opts: SnapshotRunnerOptions,
): StandaloneLLMRunner {
  return new StandaloneLLMRunner({
    config: standaloneConfigFromSnapshot(snapshot, {
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    }),
    model: snapshot.modelId,
    enableTools: opts.enableTools,
    logger: opts.logger,
  });
}
