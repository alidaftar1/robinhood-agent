/**
 * NEWS-READER EVAL — does the ⚡NEWS extractor read real headlines correctly?
 *
 *   EVAL_LLM=1 bun --env-file=.env.local test evals/news-reader.test.ts
 *
 * lib/news turns a stock's recent headlines into one ⚡NEWS flag (material event + direction), and
 * a bearish flag is a verified exit reason in the sell rail (lib/sell-rail justifiedReason). Until
 * this file the extractor had no accuracy test: evals/news-identity.test.ts drives it with a
 * scripted fake client, which proves the plumbing and nothing about the model's reading. Two live
 * misreads in two days are why this exists:
 *   2026-11-03  "Merck to Divest CDMO Business to Lonza" — Merck KGaA of Darmstadt, served under
 *               MRK (Merck & Co.) — became MRK ⚡NEWS↓ and fed the decision to sell MRK.
 *   2026-11-04  a multi-company daily price recap ("Merck Slides 2% Amid New Phase 3 Trial")
 *               became MRK ⚡NEWS↓ again.
 *
 * INPUTS ARE FROZEN (evals/news-reader-cases.json): real Finnhub headlines captured 2026-11-04,
 * each labeled by hand with the reason. Live feeds change hourly, so a live-fetch eval would grade
 * a different input every run. Labels are deliberately tolerant where reasonable readers differ
 * ("either, but not bearish"); the strict labels are the clear cases.
 *
 * SCORED BY CODE, no LLM judge: every label has a crisp right answer. Three gates:
 *   1. NO FALSE BEARISH FLAG on a case labeled quiet or not-bearish — bearish news can justify a
 *      sale, so this one is held at zero.
 *   2. IDENTITY: isAboutOtherCompany must say OTHER for the Merck KGaA items and must NOT for this
 *      company's own news — both directions, so it cannot pass by always answering one way.
 *      RECAP (added 2026-11-05 with the bearish second look): isPriceRecap must say RECAP for
 *      movers lists / "X slides 2%" items and must NOT for real bearish events headlined with a
 *      price move ("Cuts Full-Year Outlook…; Shares Plunge") — again both directions. The
 *      extraction set also carries two real bearish events (FIS, DG) that must still come through.
 *   3. OVERALL accuracy >= MIN_ACCURACY across extraction cases (room for borderline labels).
 * A FAILED extraction (malformed reply / API error) counts against the case, reported apart.
 *
 * Opt-in like the other LLM evals (EVAL_LLM=1). ~35-60 Haiku calls at temperature 0, counted and
 * capped by the wrapper below.
 */
import { describe, it, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { extractMaterialNews, isAboutOtherCompany, isPriceRecap, FAILED } from "@/lib/news";
import { LLM_EVALS_ENABLED } from "./llm-budget";
import CASES from "./news-reader-cases.json";

type Headline = { headline: string; date: string; summary?: string };
type Expect = { material: boolean | "either"; direction?: "+" | "-" | "0"; forbid?: Array<"+" | "-" | "0"> };
type ExtractionCase = { id: string; symbol: string; companyName: string; headlines: Headline[]; expect: Expect; why: string };
type IdentityCase = { id: string; symbol: string; companyName: string; item: Headline; other: boolean };
type RecapCase = { id: string; symbol: string; companyName: string; item: Headline; recap: boolean };

const MIN_ACCURACY = 0.85;
const MAX_CALLS = 90;

/** Counts and caps model calls. The extractor makes its own calls, so the shared llm-budget
 *  reservation cannot sit in front of them; this does the same job for this file. */
function countingClient(real: Anthropic): { client: Anthropic; calls: () => number } {
  let n = 0;
  const messages = {
    create: (args: Parameters<Anthropic["messages"]["create"]>[0]) => {
      if (++n > MAX_CALLS) throw new Error(`news-reader eval: over its ${MAX_CALLS}-call cap`);
      return real.messages.create(args as never);
    },
  };
  return { client: { messages } as unknown as Anthropic, calls: () => n };
}

type Verdict = { material: boolean; direction?: string; summary?: string } | "FAILED";

/** Pure: does a verdict satisfy a label? Exported shape is tested below without any model. */
export function grade(v: Verdict, e: Expect): { pass: boolean; falseBearish: boolean } {
  if (v === "FAILED") return { pass: false, falseBearish: false };
  const bearishForbidden = e.material === false || (e.forbid ?? []).includes("-");
  const falseBearish = bearishForbidden && v.material && v.direction === "-";
  if (e.material === false) return { pass: !v.material, falseBearish };
  if (v.material && e.forbid?.includes(v.direction as "+" | "-" | "0")) return { pass: false, falseBearish };
  if (e.material === "either") return { pass: true, falseBearish };
  return { pass: v.material && (e.direction == null || v.direction === e.direction), falseBearish };
}

describe("news-reader grading (deterministic)", () => {
  it("quiet label: no event passes, any event fails, a bearish one is a false-bearish", () => {
    expect(grade({ material: false }, { material: false }).pass).toBe(true);
    expect(grade({ material: true, direction: "+" }, { material: false }).pass).toBe(false);
    expect(grade({ material: true, direction: "-" }, { material: false })).toEqual({ pass: false, falseBearish: true });
  });
  it("either-not-bearish label: none and + pass, - fails as false-bearish", () => {
    const e: Expect = { material: "either", forbid: ["-"] };
    expect(grade({ material: false }, e).pass).toBe(true);
    expect(grade({ material: true, direction: "+" }, e).pass).toBe(true);
    expect(grade({ material: true, direction: "-" }, e)).toEqual({ pass: false, falseBearish: true });
  });
  it("event label: needs the event AND its direction; FAILED never passes", () => {
    const e: Expect = { material: true, direction: "+" };
    expect(grade({ material: true, direction: "+" }, e).pass).toBe(true);
    expect(grade({ material: true, direction: "0" }, e).pass).toBe(false);
    expect(grade({ material: false }, e).pass).toBe(false);
    expect(grade("FAILED", e).pass).toBe(false);
  });
  it("case file is well-formed and covers every gate", () => {
    const ex = CASES.extraction as ExtractionCase[], id = CASES.identity as IdentityCase[];
    expect(ex.length).toBeGreaterThanOrEqual(25);
    expect(new Set(ex.map(c => c.id)).size).toBe(ex.length);
    for (const c of ex) { expect(c.headlines.length).toBeGreaterThan(0); expect(c.why.length).toBeGreaterThan(10); }
    expect(ex.some(c => c.expect.material === true)).toBe(true);    // recall is tested, not only silence
    expect(ex.some(c => c.expect.material === false)).toBe(true);
    expect(id.some(c => c.other) && id.some(c => !c.other)).toBe(true);
    const rc = CASES.recap as RecapCase[];
    expect(rc.some(c => c.recap) && rc.some(c => !c.recap)).toBe(true);
    expect(ex.some(c => c.expect.material === true && c.expect.direction === "-")).toBe(true);  // bearish recall too
  });
});

describe.skipIf(!LLM_EVALS_ENABLED)("news-reader (LLM): frozen real headlines", () => {
  const { client, calls } = countingClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 }));

  it("extracts events per the labels: zero false-bearish flags, accuracy >= MIN_ACCURACY", async () => {
    const rows: Array<{ c: ExtractionCase; v: Verdict; pass: boolean; falseBearish: boolean }> = [];
    for (const c of CASES.extraction as ExtractionCase[]) {
      const r = await extractMaterialNews(client, c.symbol, c.headlines, c.companyName);
      const v: Verdict = r === FAILED ? "FAILED" : r ? { material: true, direction: r.direction, summary: r.summary } : { material: false };
      rows.push({ c, v, ...grade(v, c.expect) });
    }
    const show = (v: Verdict) => v === "FAILED" ? "FAILED" : v.material ? `${v.direction} ${v.summary}` : "none";
    console.log(`\n── news-reader: ${rows.filter(r => r.pass).length}/${rows.length} pass, ${calls()} model calls ──`);
    for (const r of rows) console.log(`  ${r.pass ? "✓" : r.falseBearish ? "✗↓" : "✗"} ${r.c.id.padEnd(18)} → ${show(r.v).slice(0, 90)}${r.pass ? "" : `   [label: ${JSON.stringify(r.c.expect)} — ${r.c.why.slice(0, 120)}]`}`);
    const falseBearish = rows.filter(r => r.falseBearish).map(r => `${r.c.id}: ${show(r.v)}`);
    const failed = rows.filter(r => r.v === "FAILED").map(r => r.c.id);
    if (failed.length) console.log(`  FAILED extractions (malformed reply / API error): ${failed.join(", ")}`);
    expect(falseBearish).toEqual([]);
    expect(rows.filter(r => r.pass).length / rows.length).toBeGreaterThanOrEqual(MIN_ACCURACY);
  }, 600_000);

  it("identity check: OTHER for Merck KGaA items, never OTHER for the company's own news", async () => {
    const wrong: string[] = [];
    for (const c of CASES.identity as IdentityCase[]) {
      const said = await isAboutOtherCompany(client, c.symbol, c.companyName, c.item);
      if (said !== c.other) wrong.push(`${c.id}: said ${said ? "OTHER" : "not OTHER"}, expected ${c.other ? "OTHER" : "SAME"} — ${c.item.headline.slice(0, 70)}`);
    }
    console.log(`\n── news-reader identity: ${(CASES.identity as IdentityCase[]).length - wrong.length}/${(CASES.identity as IdentityCase[]).length} ──`);
    for (const w of wrong) console.log(`  ✗ ${w}`);
    expect(wrong).toEqual([]);
  }, 300_000);

  it("recap check: RECAP for price-move items, never for real bearish events", async () => {
    const wrong: string[] = [];
    for (const c of CASES.recap as RecapCase[]) {
      const said = await isPriceRecap(client, c.symbol, c.companyName, c.item);
      if (said !== c.recap) wrong.push(`${c.id}: said ${said ? "RECAP" : "not RECAP"}, expected ${c.recap ? "RECAP" : "EVENT"} — ${c.item.headline.slice(0, 70)}`);
    }
    console.log(`\n── news-reader recap: ${(CASES.recap as RecapCase[]).length - wrong.length}/${(CASES.recap as RecapCase[]).length} ──`);
    for (const w of wrong) console.log(`  ✗ ${w}`);
    expect(wrong).toEqual([]);
  }, 300_000);
});
