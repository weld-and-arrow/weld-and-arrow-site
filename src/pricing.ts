import type { Env, ModelKind, Usage } from "./types";

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function priceFor(model: ModelKind, env: Pick<Env, "PRICE_FABLE_INPUT" | "PRICE_FABLE_OUTPUT" | "PRICE_HAIKU_INPUT" | "PRICE_HAIKU_OUTPUT">) {
  if (model === "fable") {
    return {
      input: asNumber(env.PRICE_FABLE_INPUT),
      output: asNumber(env.PRICE_FABLE_OUTPUT)
    };
  }
  return {
    input: asNumber(env.PRICE_HAIKU_INPUT),
    output: asNumber(env.PRICE_HAIKU_OUTPUT)
  };
}

export function costUSD(usage: Usage | undefined | null, model: ModelKind, env: Env): number {
  if (!usage) return 0;

  const price = priceFor(model, env);
  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheCreation = usage.cache_creation;
  const cache5m = asNumber(cacheCreation?.ephemeral_5m_input_tokens);
  const cache1h = asNumber(cacheCreation?.ephemeral_1h_input_tokens);
  const hasBreakdown = cache5m > 0 || cache1h > 0;
  const fallbackCreation = hasBreakdown ? 0 : asNumber(usage.cache_creation_input_tokens);

  const inputCost = input * price.input;
  const outputCost = output * price.output;
  const cacheReadCost = cacheRead * price.input * 0.1;
  const cache5mCost = cache5m * price.input * 1.25;
  const cache1hCost = cache1h * price.input * 2;
  const fallbackCreationCost = fallbackCreation * price.input * 2;

  return (inputCost + outputCost + cacheReadCost + cache5mCost + cache1hCost + fallbackCreationCost) / 1_000_000;
}

export function cacheCreation1hTokens(usage: Usage | undefined | null): number {
  if (!usage) return 0;
  const explicit = asNumber(usage.cache_creation?.ephemeral_1h_input_tokens);
  if (explicit > 0) return explicit;
  return asNumber(usage.cache_creation_input_tokens);
}

export function usageLogFields(usage: Usage | undefined | null) {
  return {
    input_tokens: asNumber(usage?.input_tokens),
    output_tokens: asNumber(usage?.output_tokens),
    cache_read_input_tokens: asNumber(usage?.cache_read_input_tokens),
    cache_creation_input_tokens: asNumber(usage?.cache_creation_input_tokens),
    cache_creation: usage?.cache_creation ?? null
  };
}
