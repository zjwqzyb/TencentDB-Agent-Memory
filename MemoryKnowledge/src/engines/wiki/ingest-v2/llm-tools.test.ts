import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmClient } from "./llm.js";

interface Recorded {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function completion(message: Record<string, unknown>, model = "snapshot-model") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

let server: Server;
let baseUrl: string;
let requests: Recorded[];
let mode: "tools" | "auth-error";

beforeEach(async () => {
  requests = [];
  mode = "tools";
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({ url: req.url, headers: req.headers, body });
    const json = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (mode === "auth-error") {
      return json(401, {
        error: {
          message: "Incorrect API key provided: sk-tool-secret (authorization: Bearer sk-tool-secret)",
        },
      });
    }
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1] ?? {};
    if (last.role === "tool") {
      const text = String(last.content ?? "");
      return json(200, completion({ content: `tool result observed: ${text}` }));
    }
    if (Array.isArray(body.tools)) {
      return json(
        200,
        completion({
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_nonce", arguments: '{"seed":"abc"}' },
            },
          ],
        }),
      );
    }
    return json(200, completion({ content: "plain" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

const client = () =>
  createLlmClient({
    baseUrl,
    apiKey: "sk-tool-secret",
    model: "snapshot-model",
    maxTokens: 4096,
    timeoutMs: 5_000,
    modelConfig: {
      source: "managed",
      configId: "snap-tools",
      version: 7,
      fingerprint: "sha256:0123456789abcdef",
      snapshotId: "snap-tools",
    },
  });

describe("Wiki LLM tool capability", () => {
  it("runs the tool loop on the same provider/model/credential snapshot", async () => {
    const result = await client().chatWithTools({
      system: "You may call tools.",
      prompt: "Read the nonce.",
      label: "tools:probe",
      tools: [
        {
          name: "read_nonce",
          description: "Returns a deterministic nonce",
          parameters: {
            type: "object",
            properties: { seed: { type: "string" } },
            required: ["seed"],
            additionalProperties: false,
          },
        },
      ],
      execute: (call) => ({ nonce: `nonce-${JSON.parse(call.arguments).seed}` }),
    });

    expect(result.calls).toEqual([
      { id: "read_nonce-1", name: "read_nonce", arguments: '{"seed":"abc"}' },
    ]);
    expect(result.results).toEqual([{ nonce: "nonce-abc" }]);
    expect(result.text).toContain("nonce-abc");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.body.model).toBe("snapshot-model");
      expect(request.headers.authorization).toBe("Bearer sk-tool-secret");
    }
  });

  it("redacts the credential from upstream error logs", async () => {
    mode = "auth-error";
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await expect(
        client().chat({ system: "Base", prompt: "Source", label: "generate:probe" }),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).not.toContain("sk-tool-secret");
    expect(errors.join("\n")).toContain("[REDACTED]");
  });
});
