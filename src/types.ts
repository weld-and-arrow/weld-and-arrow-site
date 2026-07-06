export type Role = "user" | "assistant";
export type ModelKind = "fable" | "haiku";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  [key: string]: unknown;
}

export interface LimitResult {
  ok: true;
}

export interface LimitedResult {
  ok: false;
  scope: "hour" | "day" | "week";
  resetsAt: string;
}

export type BudgetCheckResult = LimitResult | LimitedResult;

export interface Env {
  ASSETS: Fetcher;
  BUDGET: DurableObjectNamespace;
  TRANSCRIPTS: DurableObjectNamespace;
  STATE: KVNamespace;

  ANTHROPIC_API_KEY: string;
  ADMIN_TOKEN: string;
  TURNSTILE_SECRET: string;

  PRICE_FABLE_INPUT: string;
  PRICE_FABLE_OUTPUT: string;
  PRICE_HAIKU_INPUT: string;
  PRICE_HAIKU_OUTPUT: string;

  LIMIT_HOUR_USD: string;
  LIMIT_DAY_USD: string;
  LIMIT_WEEK_USD: string;
  CHAT_ENABLED: string;
  WARM_ENABLED: string;
  WARM_IDLE_CUTOFF_MS: string;
  RETENTION_DAYS: string;
  ARTIFACT_URL: string;
  COMMIT_HASH: string;
  TURNSTILE_SITE_KEY: string;
  MAX_TOKENS_FABLE: string;
  MAX_TURNS: string;
}

export interface SessionAppend {
  sessionId: string;
  role: Role;
  content: string;
  model?: string | null;
  usage?: Usage | null;
  ts?: number;
}
