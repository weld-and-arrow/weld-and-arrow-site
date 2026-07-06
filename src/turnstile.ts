import type { Env } from "./types";

export async function verifyTurnstile(token: string, env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    throw new Error("TURNSTILE_SECRET is not configured");
  }

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });

  if (!response.ok) return false;
  const body = await response.json<{ success?: boolean }>();
  return body.success === true;
}
