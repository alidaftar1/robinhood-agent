import { after } from "next/server";
import { redisPipeline, redisCommand } from "./run-store";

// Token metering for every production model call. Until 2026-11-27 nothing recorded usage, so
// "what does this cost" could only be estimated. createAnthropic(label) wraps the client; each
// messages.create / beta.messages.create response's `usage` is added to a per-PT-date Redis hash.
//
// It can never change a call's outcome or its timing: the SDK's own promise is returned untouched
// (its .withResponse() helpers kept), and the Redis write is handed to next/server `after()`, so it
// runs once the response is sent instead of delaying the caller — the trade route's time budget is
// already tight. Outside a request (scripts, tests) it simply runs in the background. A metering
// failure is logged and swallowed: a missing count is a visible gap, a failed trade would not be.
// Not metered: streamed responses, and calls that error or are aborted (an aborted call may still
// be billed) — the totals are a floor.

const KEY = (date: string) => `llm-usage:${date}`;
const TTL_SECONDS = 120 * 86_400;
const ptDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

/** Pure: the hash increments for one response. `|` is the field separator, so it is stripped from labels. */
export function usageFields(label: string, model: string, u: Usage | undefined): Array<[string, number]> {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : 0);
  const k = `${label.replace(/\|/g, "/")}|${model.replace(/\|/g, "/")}`;
  return [
    [`${k}|calls`, 1],
    [`${k}|in`, n(u?.input_tokens)],
    [`${k}|out`, n(u?.output_tokens)],
    [`${k}|cacheRead`, n(u?.cache_read_input_tokens)],
    [`${k}|cacheWrite`, n(u?.cache_creation_input_tokens)],
  ];
}

async function record(label: string, model: string, usage: Usage | undefined): Promise<void> {
  const key = KEY(ptDate());
  const cmds: unknown[] = usageFields(label, model, usage).map(([f, v]) => ["HINCRBY", key, f, v]);
  cmds.push(["EXPIRE", key, TTL_SECONDS]);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  // redisPipeline throws on a non-ok response, so a bad token is logged, not silently dropped.
  try { await redisPipeline(cmds, ctl.signal); }
  catch (e) { console.warn("LLM_USAGE_RECORD_FAILED", String(e).slice(0, 120)); }
  finally { clearTimeout(t); }
}

// EVAL RUNS tally in memory instead: an eval run must never write into the production meter (a
// local `test:llm` carries .env.local's Upstash credentials, and lib/news etc. use createAnthropic),
// and CI has no Redis at all. evals/usage-report.preload.ts prints it once per run ("EVAL TOKEN USAGE").
const memoryMode = () => process.env.EVAL_LLM === "1" || process.env.LLM_USAGE_SINK === "memory";
const tally: Record<string, number> = {};

/** The in-memory tally as rows (eval runs). */
export function memoryTally(): UsageRow[] { return summarizeUsage(tally); }

/** Pure: the report printed at the end of an eval run. */
export function formatTally(rows: UsageRow[]): string {
  if (rows.length === 0) return "EVAL TOKEN USAGE: no metered model calls.";
  const total = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const lines = rows.map(r => `EVAL TOKEN USAGE   ${r.label.padEnd(28)} ${r.model.padEnd(28)} ${String(r.calls).padStart(4)} calls `
    + `${String(r.in).padStart(9)} in ${String(r.out).padStart(8)} out  ${r.costUsd == null ? "unpriced" : `$${r.costUsd.toFixed(3)}`}`);
  return [...lines, `EVAL TOKEN USAGE   TOTAL ~$${total.toFixed(2)} across ${rows.reduce((s, r) => s + r.calls, 0)} calls`
    + `${rows.some(r => r.costUsd == null) ? " (some models unpriced)" : ""} — a floor: errored or aborted calls are not counted`].join("\n");
}

function schedule(label: string, model: string, usage: Usage | undefined): void {
  if (memoryMode()) {
    for (const [f, v] of usageFields(label, model, usage)) tally[f] = (tally[f] ?? 0) + v;
    return;
  }
  const job = () => record(label, model, usage).catch(() => {});
  try { after(job); } catch { void job(); } // after() throws outside a request scope
}

/** Wraps `create` on client.messages and client.beta.messages. Everything else passes through. */
export function meterAnthropic<T extends object>(client: T, label: string): T {
  const wrapCreate = (messages: any) => new Proxy(messages, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== "create" || typeof v !== "function") return v;
      return (...args: any[]) => {
        const p = v.apply(target, args);
        // Observe, never replace: the caller gets the SDK's promise. A stream has no usage yet and
        // is not metered; a rejection is the caller's to handle and is not counted.
        Promise.resolve(p).then((res: any) => {
          if (res && typeof res === "object" && "usage" in res) {
            schedule(label, String(res.model ?? args[0]?.model ?? "unknown"), res.usage);
          }
        }, () => {});
        return p;
      };
    },
  });
  return new Proxy(client, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "messages" && v) return wrapCreate(v);
      if (prop === "beta" && v) return new Proxy(v, { get: (b, p, r) => { const x = Reflect.get(b, p, r); return p === "messages" && x ? wrapCreate(x) : x; } });
      return v;
    },
  });
}

/** $ per million tokens. Cache reads bill 0.1x input, cache writes 1.25x (5-minute TTL). */
const PRICES: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /^claude-sonnet-4-6/, input: 3, output: 15 },
  { match: /^claude-haiku-4-5/, input: 1, output: 5 },
  { match: /^claude-opus-4-[5-8]/, input: 5, output: 25 },
];

export type UsageRow = { label: string; model: string; calls: number; in: number; out: number; cacheRead: number; cacheWrite: number; costUsd: number | null };

/** Pure: a day's hash → rows with an estimated cost (null for a model with no known price). */
export function summarizeUsage(hash: Record<string, string | number>): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const [f, raw] of Object.entries(hash)) {
    const parts = f.split("|");
    if (parts.length !== 3) continue;
    const [label, model, metric] = parts;
    const key = `${label}|${model}`;
    const r = rows.get(key) ?? { label, model, calls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: null };
    const v = Number(raw);
    if (Number.isFinite(v) && metric in r && metric !== "label" && metric !== "model" && metric !== "costUsd") (r as any)[metric] += v;
    rows.set(key, r);
  }
  for (const r of rows.values()) {
    const p = PRICES.find(x => x.match.test(r.model));
    r.costUsd = p ? (r.in * p.input + r.out * p.output + r.cacheRead * p.input * 0.1 + r.cacheWrite * p.input * 1.25) / 1e6 : null;
  }
  return [...rows.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}

/** Pure: the calendar date `n` days before `date` (YYYY-MM-DD), by date arithmetic — subtracting
 *  24h blocks from "now" repeats or skips a day across a DST change. */
export function daysBefore(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Pure: the dates the weekday email reports — yesterday, or Friday to Sunday on a Monday, so
 *  Friday's spend is not skipped by a Monday-to-Friday cron. */
export function usageDatesSince(today: string): string[] {
  const isMonday = new Date(`${today}T12:00:00Z`).getUTCDay() === 1;
  return (isMonday ? [3, 2, 1] : [1]).map(n => daysBefore(today, n));
}

/** Bounded: a hung read must not hold up the 8am email for an informational line. */
export async function getUsage(date: string): Promise<UsageRow[]> {
  const flat = (await Promise.race([
    redisCommand("hgetall", KEY(date)),
    new Promise((_, rej) => setTimeout(() => rej(new Error("llm-usage read timed out")), 2500)),
  ])) as string[] | Record<string, string> | null;
  if (!flat) return [];
  const hash: Record<string, string> = Array.isArray(flat)
    ? Object.fromEntries(Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]))
    : flat;
  return summarizeUsage(hash);
}
