import type { BudgetCheckResult, ModelKind, SessionAppend, Usage } from "./types";
import type { TranscriptSearch } from "./transcripts";
import type { Env } from "./types";

export interface BudgetRemote {
  check(nowMs?: number): Promise<BudgetCheckResult>;
  settle(usage: Usage, model: ModelKind, nowMs?: number): Promise<{ usd: number }>;
  totals(nowMs?: number): Promise<unknown>;
  cleanup(nowMs?: number): Promise<{ deleted: number }>;
}

export interface TranscriptRemote {
  createSession(consentTs: number, noticeVersion: string, commitHash: string): Promise<{ sessionId: string }>;
  hasSession(sessionId: string): Promise<boolean>;
  append(entries: SessionAppend[]): Promise<{ inserted: number }>;
  search(query: TranscriptSearch): Promise<unknown>;
  deleteSessions(ids: string[]): Promise<{ deletedSessions: number }>;
  purgeOlderThan(retentionDays: number, nowMs?: number): Promise<{ deletedSessions: number }>;
}

export function budgetStub(env: Env): BudgetRemote {
  const id = env.BUDGET.idFromName("global");
  return env.BUDGET.get(id) as unknown as BudgetRemote;
}

export function transcriptStub(env: Env): TranscriptRemote {
  const namespace = env.TRANSCRIPTS.jurisdiction("eu");
  const id = namespace.idFromName("main");
  return namespace.get(id) as unknown as TranscriptRemote;
}
