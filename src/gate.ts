import { createMessage, extractTextContent } from "./anthropic";
import { GATE_SYSTEM_PROMPT } from "./prompts";
import type { Env, Usage } from "./types";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export async function passesGate(message: string, env: Env): Promise<{ pass: boolean; usage: Usage }> {
  const response = await createMessage(env, {
    model: HAIKU_MODEL,
    max_tokens: 4,
    temperature: 0,
    system: GATE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: message }]
  });

  const text = extractTextContent(response.content).trim().toUpperCase();
  return {
    pass: text.startsWith("YES"),
    usage: (response.usage ?? {}) as Usage
  };
}
