import { BudgetDO } from "./budget";
import { FABLE_MODEL, streamFable } from "./fable";
import { passesGate } from "./gate";
import { NOTICE_VERSION, sourceCommit } from "./prompts";
import { budgetStub, transcriptStub } from "./stubs";
import { verifyTurnstile } from "./turnstile";
import type { BudgetCheckResult, ChatMessage, Env, Usage } from "./types";
import { warmCache } from "./warm";
import { TranscriptDO } from "./transcripts";

export { BudgetDO, TranscriptDO };

const SELF_SERVE_URL = "/";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
};

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(key, value);
  }
  return secured;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return withSecurityHeaders(new Response(JSON.stringify(body), { ...init, headers }));
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "no-store");
  return withSecurityHeaders(new Response(body, { ...init, headers }));
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function numberVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolVar(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function chatEnabled(env: Env): boolean {
  return boolVar(env.CHAT_ENABLED, false);
}

function enforceSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const expected = new URL(request.url).origin;
  if (origin === expected) return null;
  return jsonResponse({ error: "same_origin_required" }, { status: 403 });
}

function limitedResponse(result: BudgetCheckResult, env: Env): Response | null {
  if (result.ok) return null;
  return jsonResponse(
    {
      limited: true,
      scope: result.scope,
      resetsAt: result.resetsAt,
      artifactUrl: env.ARTIFACT_URL,
      selfServeUrl: SELF_SERVE_URL
    },
    { status: 429 }
  );
}

function chatDisabledResponse(env: Env): Response {
  return jsonResponse(
    {
      error: "chat_disabled",
      message: "The hosted chat is currently disabled. Use the self-serve options on the home page instead.",
      artifactUrl: env.ARTIFACT_URL,
      selfServeUrl: SELF_SERVE_URL
    },
    { status: 503 }
  );
}

function parseMessages(value: unknown, maxTurns: number): { ok: true; messages: ChatMessage[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "messages must be an array" };
  if (value.length === 0) return { ok: false, error: "messages must not be empty" };
  if (value.length > maxTurns) return { ok: false, error: "too_many_turns" };

  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, error: "invalid message" };
    if (item.role !== "user" && item.role !== "assistant") return { ok: false, error: "invalid role" };
    if (typeof item.content !== "string" || item.content.trim() === "") return { ok: false, error: "invalid content" };
    messages.push({ role: item.role, content: item.content });
  }

  if (messages[messages.length - 1]?.role !== "user") {
    return { ok: false, error: "latest message must be from user" };
  }

  return { ok: true, messages };
}

function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAdmin(request: Request, env: Env): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  return request.headers.get("authorization") === `Bearer ${token}`;
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body) || body.consent !== true || typeof body.turnstileToken !== "string") {
    return jsonResponse({ error: "consent_and_turnstile_required" }, { status: 400 });
  }

  const verified = await verifyTurnstile(body.turnstileToken, env);
  if (!verified) return jsonResponse({ error: "turnstile_failed" }, { status: 403 });

  const commit = sourceCommit(env);
  const session = await transcriptStub(env).createSession(Date.now(), NOTICE_VERSION, commit);
  return jsonResponse({
    sessionId: session.sessionId,
    commit,
    artifactUrl: env.ARTIFACT_URL,
    noticeVersion: NOTICE_VERSION
  });
}

async function settleGateUsage(env: Env, usage: Usage): Promise<Response | null> {
  await budgetStub(env).settle(usage, "haiku");
  return limitedResponse(await budgetStub(env).check(), env);
}

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body) || typeof body.sessionId !== "string") {
    return jsonResponse({ error: "sessionId_required" }, { status: 400 });
  }

  const maxTurns = intVar(env.MAX_TURNS, 40);
  const parsed = parseMessages(body.messages, maxTurns);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, { status: 400 });

  const transcripts = transcriptStub(env);
  const validSession = await transcripts.hasSession(body.sessionId);
  if (!validSession) return jsonResponse({ error: "unknown_session" }, { status: 404 });

  const preflightLimit = limitedResponse(await budgetStub(env).check(), env);
  if (preflightLimit) return preflightLimit;

  await env.STATE.put("lastActivity", String(Date.now()));

  const latest = parsed.messages[parsed.messages.length - 1];
  const gate = await passesGate(latest.content, env);
  const postGateLimit = await settleGateUsage(env, gate.usage);
  if (postGateLimit) return postGateLimit;

  if (!gate.pass) {
    await transcripts.append([
      {
        sessionId: body.sessionId,
        role: "user",
        content: latest.content,
        model: null,
        usage: null
      },
      {
        sessionId: body.sessionId,
        role: "assistant",
        content: "Mu",
        model: FABLE_MODEL,
        usage: { gate: gate.usage } as Usage
      }
    ]);
    return jsonResponse({ mu: true, message: "Mu" });
  }

  const stream = await streamFable(parsed.messages, body.sessionId, latest.content, env, ctx);
  return withSecurityHeaders(stream);
}

function handleConfig(env: Env): Response {
  return jsonResponse({
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    artifactUrl: env.ARTIFACT_URL,
    selfServeUrl: SELF_SERVE_URL,
    chatEnabled: chatEnabled(env),
    commit: sourceCommit(env),
    noticeVersion: NOTICE_VERSION,
    maxTurns: intVar(env.MAX_TURNS, 40)
  });
}

async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!isAdmin(request, env)) return jsonResponse({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/admin/transcripts/search") {
    const result = await transcriptStub(env).search({
      q: url.searchParams.get("q") ?? undefined,
      fromTs: parseTimestamp(url.searchParams.get("from")),
      toTs: parseTimestamp(url.searchParams.get("to")),
      sessionId: url.searchParams.get("session") ?? undefined
    });
    return jsonResponse(result);
  }

  if (request.method === "DELETE" && url.pathname === "/admin/transcripts") {
    const ids = (url.searchParams.get("sessions") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return jsonResponse({ error: "sessions_required" }, { status: 400 });
    return jsonResponse(await transcriptStub(env).deleteSessions(ids));
  }

  if (request.method === "GET" && url.pathname === "/admin/spend") {
    return jsonResponse(await budgetStub(env).totals());
  }

  return jsonResponse({ error: "not_found" }, { status: 404 });
}

async function fetchAssetPage(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  return withSecurityHeaders(await env.ASSETS.fetch(new Request(url, request)));
}

async function fetchStatic(request: Request, env: Env): Promise<Response> {
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin/")) {
    const originError = enforceSameOrigin(request);
    if (originError) return originError;
  }

  if (request.method === "GET" && url.pathname === "/api/config") return handleConfig(env);
  if (request.method === "POST" && url.pathname === "/api/session") {
    if (!chatEnabled(env)) return chatDisabledResponse(env);
    return handleSession(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    if (!chatEnabled(env)) return chatDisabledResponse(env);
    return handleChat(request, env, ctx);
  }
  if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env);
  if (request.method === "GET" && url.pathname === "/privacy") return fetchAssetPage(request, env, "/privacy.html");
  if (request.method === "GET" && url.pathname === "/use-your-own") {
    return fetchAssetPage(request, env, "/index.html");
  }
  if (request.method === "GET" || request.method === "HEAD") return fetchStatic(request, env);

  return textResponse("Method not allowed", { status: 405 });
}

async function runScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  if (event.cron === "0 3 * * *") {
    const retentionDays = numberVar(env.RETENTION_DAYS, 365);
    const [purged, budgetCleanup] = await Promise.all([
      transcriptStub(env).purgeOlderThan(retentionDays),
      budgetStub(env).cleanup()
    ]);
    console.log("retention complete", { purged, budgetCleanup });
    return;
  }

  if (!chatEnabled(env)) {
    console.log("warm skip: chat disabled");
    return;
  }

  await warmCache(env);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(error);
      return jsonResponse({ error: "internal_error" }, { status: 500 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(event, env));
  }
};
