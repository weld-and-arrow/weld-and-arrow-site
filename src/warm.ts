import { createMessage } from "./anthropic";
import { buildWarmRequest } from "./fable";
import { cacheCreation1hTokens, usageLogFields } from "./pricing";
import { budgetStub } from "./stubs";
import type { Env, Usage } from "./types";

function boolVar(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function warmCache(env: Env): Promise<{ warmed: boolean; reason?: string }> {
  if (!boolVar(env.WARM_ENABLED, true)) return { warmed: false, reason: "disabled" };

  const lastActivity = Number(await env.STATE.get("lastActivity"));
  if (!Number.isFinite(lastActivity)) return { warmed: false, reason: "idle" };

  const cutoff = intVar(env.WARM_IDLE_CUTOFF_MS, 7200000);
  if (Date.now() - lastActivity > cutoff) {
    console.log("warm skip: idle");
    return { warmed: false, reason: "idle" };
  }

  const budget = await budgetStub(env).check();
  if (!budget.ok) return { warmed: false, reason: "budget" };

  const response = await createMessage(env, buildWarmRequest(env));
  const usage = (response.usage ?? {}) as Usage;
  await budgetStub(env).settle(usage, "fable");

  const fields = usageLogFields(usage);
  console.log("warm usage", fields);
  if (cacheCreation1hTokens(usage) > 0) {
    console.warn("warm cache produced a 1h cache write", fields);
  }
  return { warmed: true };
}
