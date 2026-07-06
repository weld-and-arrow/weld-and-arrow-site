import { DurableObject } from "cloudflare:workers";
import { costUSD } from "./pricing";
import type { BudgetCheckResult, Env, ModelKind, Usage } from "./types";

type Scope = "hour" | "day" | "week";

interface Period {
  scope: Scope;
  key: string;
  limit: number;
  resetsAt: Date;
}

function numberVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoWeek(date: Date): { year: number; week: number } {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: copy.getUTCFullYear(), week };
}

function nextMonday(date: Date): Date {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() + (8 - day));
  return result;
}

function periodsFor(now: Date, env: Env): Period[] {
  const year = now.getUTCFullYear();
  const month = pad2(now.getUTCMonth() + 1);
  const day = pad2(now.getUTCDate());
  const hour = pad2(now.getUTCHours());
  const week = isoWeek(now);

  return [
    {
      scope: "hour",
      key: `H:${year}-${month}-${day}T${hour}`,
      limit: numberVar(env.LIMIT_HOUR_USD, 1.28),
      resetsAt: new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1))
    },
    {
      scope: "day",
      key: `D:${year}-${month}-${day}`,
      limit: numberVar(env.LIMIT_DAY_USD, 4.45),
      resetsAt: new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate() + 1))
    },
    {
      scope: "week",
      key: `W:${week.year}-W${pad2(week.week)}`,
      limit: numberVar(env.LIMIT_WEEK_USD, 12.8),
      resetsAt: nextMonday(now)
    }
  ];
}

function parsePeriodStart(key: string): number | null {
  if (key.startsWith("H:")) return Date.parse(`${key.slice(2)}:00:00Z`);
  if (key.startsWith("D:")) return Date.parse(`${key.slice(2)}T00:00:00Z`);
  if (key.startsWith("W:")) {
    const match = /^W:(\d{4})-W(\d{2})$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const week = Number(match[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const mondayWeek1 = new Date(jan4);
    mondayWeek1.setUTCDate(jan4.getUTCDate() + 1 - jan4Day);
    mondayWeek1.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
    return mondayWeek1.getTime();
  }
  return null;
}

export class BudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS spend (
        period_key TEXT PRIMARY KEY,
        usd REAL NOT NULL
      );
    `);
  }

  check(nowMs = Date.now()): BudgetCheckResult {
    const now = new Date(nowMs);
    const periods = periodsFor(now, this.env);
    const breached = periods
      .map((period) => ({
        ...period,
        usd: this.getSpend(period.key)
      }))
      .filter((period) => period.usd >= period.limit);

    if (breached.length === 0) return { ok: true };

    breached.sort((a, b) => a.resetsAt.getTime() - b.resetsAt.getTime());
    const first = breached[0];
    return {
      ok: false,
      scope: first.scope,
      resetsAt: first.resetsAt.toISOString()
    };
  }

  settle(usage: Usage, model: ModelKind, nowMs = Date.now()): { usd: number } {
    const usd = costUSD(usage, model, this.env);
    const periods = periodsFor(new Date(nowMs), this.env);
    for (const period of periods) {
      this.ctx.storage.sql.exec(
        `INSERT INTO spend (period_key, usd) VALUES (?, ?)
         ON CONFLICT(period_key) DO UPDATE SET usd = usd + excluded.usd`,
        period.key,
        usd
      );
    }
    return { usd };
  }

  totals(nowMs = Date.now()) {
    const periods = periodsFor(new Date(nowMs), this.env);
    return {
      periods: periods.map((period) => ({
        scope: period.scope,
        key: period.key,
        usd: this.getSpend(period.key),
        limit: period.limit,
        resetsAt: period.resetsAt.toISOString()
      }))
    };
  }

  cleanup(nowMs = Date.now()): { deleted: number } {
    const cutoff = nowMs - 8 * 24 * 60 * 60 * 1000;
    const rows = this.ctx.storage.sql.exec<{ period_key: string }>("SELECT period_key FROM spend").toArray();
    let deleted = 0;
    for (const row of rows) {
      const start = parsePeriodStart(row.period_key);
      if (start !== null && start < cutoff) {
        this.ctx.storage.sql.exec("DELETE FROM spend WHERE period_key = ?", row.period_key);
        deleted += 1;
      }
    }
    return { deleted };
  }

  private getSpend(key: string): number {
    const row = this.ctx.storage.sql.exec<{ usd: number }>("SELECT usd FROM spend WHERE period_key = ?", key).toArray()[0];
    return typeof row?.usd === "number" ? row.usd : 0;
  }
}
