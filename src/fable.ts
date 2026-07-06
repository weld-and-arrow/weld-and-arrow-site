import { anthropicHeaders, mergeUsageSnapshot, readAnthropicSSE } from "./anthropic";
import { buildCachedSystemBlock, sourceCommit } from "./prompts";
import { usageLogFields } from "./pricing";
import { budgetStub, transcriptStub } from "./stubs";
import type { ChatMessage, Env, Usage } from "./types";

export const FABLE_MODEL = "claude-fable-5";

function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanHistory(messages: ChatMessage[], maxTurns: number): ChatMessage[] {
  return messages.slice(-maxTurns).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

export function buildFableRequest(messages: ChatMessage[], env: Env, options?: { maxTokens?: number; stream?: boolean }) {
  const maxTokens = options?.maxTokens ?? intVar(env.MAX_TOKENS_FABLE, 2048);
  return {
    model: FABLE_MODEL,
    max_tokens: maxTokens,
    stream: options?.stream ?? false,
    system: [buildCachedSystemBlock(sourceCommit(env))],
    messages: cleanHistory(messages, intVar(env.MAX_TURNS, 40))
  };
}

export function buildWarmRequest(env: Env) {
  return buildFableRequest([{ role: "user", content: "warm" }], env, {
    maxTokens: 1,
    stream: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function safeWrite(writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder, event: string, data: unknown) {
  try {
    await writer.write(encoder.encode(encodeSSE(event, data)));
  } catch {
    // Client disconnects should not stop budget settlement or transcript writes.
  }
}

export async function streamFable(
  messages: ChatMessage[],
  sessionId: string,
  latestUserMessage: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify(buildFableRequest(messages, env, { stream: true }))
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    throw new Error(`Anthropic streaming request failed (${upstream.status}): ${detail}`);
  }

  const upstreamBody = upstream.body;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const pump = async () => {
    let assistantText = "";
    let usage: Usage = {};

    try {
      await readAnthropicSSE(upstreamBody, async (eventName, data) => {
        if (eventName === "message_start" && isRecord(data) && isRecord(data.message)) {
          usage = mergeUsageSnapshot(usage, data.message.usage);
        }

        if (eventName === "content_block_delta" && isRecord(data) && isRecord(data.delta)) {
          const delta = data.delta;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            assistantText += delta.text;
            await safeWrite(writer, encoder, "delta", { text: delta.text });
          }
        }

        if (eventName === "message_delta" && isRecord(data)) {
          usage = mergeUsageSnapshot(usage, data.usage);
        }

        if (eventName === "error") {
          throw new Error(`Anthropic stream error: ${JSON.stringify(data)}`);
        }
      });

      await budgetStub(env).settle(usage, "fable");
      await transcriptStub(env).append([
        {
          sessionId,
          role: "user",
          content: latestUserMessage,
          model: null,
          usage: null
        },
        {
          sessionId,
          role: "assistant",
          content: assistantText,
          model: FABLE_MODEL,
          usage
        }
      ]);
      await env.STATE.put("lastActivity", String(Date.now()));
      console.log("fable usage", usageLogFields(usage));
      await safeWrite(writer, encoder, "done", { usage: usageLogFields(usage) });
    } catch (error) {
      console.error(error);
      await safeWrite(writer, encoder, "error", {
        message: "The chat stream failed. Please try again."
      });
    } finally {
      try {
        await writer.close();
      } catch {
        // The client may already be gone.
      }
    }
  };

  ctx.waitUntil(pump());

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no"
    }
  });
}
