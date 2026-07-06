import type { Env, Usage } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";

export function anthropicHeaders(env: Env): HeadersInit {
  return {
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY
  };
}

export async function createMessage(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic Messages API failed (${response.status}): ${detail}`);
  }

  return response.json<Record<string, unknown>>();
}

export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
}

function mergeCacheCreation(previous: Usage["cache_creation"], next: Usage["cache_creation"]) {
  return {
    ephemeral_5m_input_tokens: next?.ephemeral_5m_input_tokens ?? previous?.ephemeral_5m_input_tokens,
    ephemeral_1h_input_tokens: next?.ephemeral_1h_input_tokens ?? previous?.ephemeral_1h_input_tokens
  };
}

export function mergeUsageSnapshot(previous: Usage, next: unknown): Usage {
  if (!next || typeof next !== "object") return previous;
  const usage = next as Usage;
  const merged: Usage = { ...previous };
  for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
    if (typeof usage[key] === "number") merged[key] = usage[key];
  }
  if (usage.cache_creation) {
    merged.cache_creation = mergeCacheCreation(previous.cache_creation, usage.cache_creation);
  }
  return merged;
}

export async function readAnthropicSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventName: string, data: unknown) => Promise<void> | void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await dispatchEvent(rawEvent, onEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    await dispatchEvent(buffer, onEvent);
  }
}

async function dispatchEvent(
  rawEvent: string,
  onEvent: (eventName: string, data: unknown) => Promise<void> | void
) {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }

  if (dataLines.length === 0) return;
  const dataText = dataLines.join("\n");
  const data = dataText === "[DONE]" ? dataText : JSON.parse(dataText);
  await onEvent(eventName, data);
}
