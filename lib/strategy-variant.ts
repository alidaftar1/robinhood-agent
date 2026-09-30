// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY VARIANTS — Tier 0 of the research agent (docs/scope-strategy-research-agent.md)
//
// A variant is a PURE FUNCTION over one day of captured features. That is the whole containment
// story, and it is deliberately structural rather than a rule anyone is asked to follow:
//
//   pick(day: VariantDay) => VariantPick[]
//
// A pure function over a feature matrix cannot place an order, cannot write a return series,
// cannot reach Redis, and cannot deploy. So the agent gets COMPLETE freedom inside pick() and
// ZERO freedom outside it. Autonomy and containment stop being in tension.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the optimizer must never control the scorer. An agent
// optimizing toward a return target, with authority over the code that COMPUTES returns, will
// eventually hit the target by changing the computation. This repo has already produced a phantom
// -14.13% day, a deposit booked as return, and a compounded-% index that silently dropped a
// realized loss — each took real work to find. Scoring lives in lib/shadow-scoring.ts and is not
// reachable from here.
//
// TIER 0 PERFORMS NO WRITES AT ALL. Picks are recomputed on READ from the stored capture, exactly
// as the existing shadows compute forward returns on read. There is no new cron, no new key, and
// no new failure mode in the trade run — a variant literally cannot affect trading.
// ─────────────────────────────────────────────────────────────────────────────

import { CAPTURE_COLUMNS, type CaptureDay } from "./feature-capture";
import { STOCK_SECTOR } from "./market-data";

export type CaptureColumn = (typeof CAPTURE_COLUMNS)[number];

/** One name on one day, as a variant sees it. Read-only by construction. */
export interface FeatureRow {
  readonly symbol: string;
  readonly price: number;
  /** null = not captured / unusable on this day. NEVER silently 0 — a missing momentum reading
   *  coerced to 0 is "perfectly flat", which is a real and rankable value. */
  get(col: CaptureColumn): number | null;
  sector(): string;
}

export interface VariantDay {
  readonly date: string;
  readonly spyPrice: number | null;
  readonly rows: readonly FeatureRow[];
}

export interface VariantPick {
  symbol: string;
  /** Higher = stronger conviction. Used only for ordering/diagnostics, never for sizing here. */
  score?: number;
}

/** Risk parameters a variant may choose. The agent picks inside the envelope; CODE owns the
 *  envelope. This is the difference between tuning a strategy and dismantling its risk controls. */
export interface VariantConfig {
  maxPositions: number;
  maxPerSector: number;
}

/** Hard bounds. Not agent-editable — changing these is a code change under the normal deploy gate. */
export const VARIANT_CONFIG_BOUNDS = {
  maxPositions: [4, 12] as const,
  maxPerSector: [1, 4] as const,
};

export const DEFAULT_VARIANT_CONFIG: VariantConfig = { maxPositions: 6, maxPerSector: 2 };

const clamp = (n: number, lo: number, hi: number) =>
  !Number.isFinite(n) ? lo : Math.min(hi, Math.max(lo, Math.round(n)));

/** Clamp rather than reject: a variant proposing maxPositions 50 should run at 12, not crash the
 *  whole replay. The clamp is reported by describeConfigClamp so it is never silent. */
export function clampVariantConfig(cfg: Partial<VariantConfig> | undefined): VariantConfig {
  const c = cfg ?? {};
  return {
    maxPositions: clamp(c.maxPositions ?? DEFAULT_VARIANT_CONFIG.maxPositions, ...VARIANT_CONFIG_BOUNDS.maxPositions),
    maxPerSector: clamp(c.maxPerSector ?? DEFAULT_VARIANT_CONFIG.maxPerSector, ...VARIANT_CONFIG_BOUNDS.maxPerSector),
  };
}

/** What was clamped, so a variant running at different parameters than it asked for says so. */
export function describeConfigClamp(requested: Partial<VariantConfig> | undefined, applied: VariantConfig): string[] {
  const out: string[] = [];
  for (const k of ["maxPositions", "maxPerSector"] as const) {
    const r = requested?.[k];
    if (r != null && r !== applied[k]) {
      out.push(`${k} ${r} → ${applied[k]} (bounds ${VARIANT_CONFIG_BOUNDS[k][0]}–${VARIANT_CONFIG_BOUNDS[k][1]})`);
    }
  }
  return out;
}

/** Pre-registered promotion criteria. Immutable by convention: changing them mints a NEW id with a
 *  fresh clock, which makes the multiple-comparisons cost VISIBLE rather than hidden. Without this
 *  an agent reads the results and then picks the threshold its best variant happens to clear. */
export interface PromotionCriteria {
  /** Minimum average excess return vs SPY, in percent, over the forward window. */
  minExcessReturnPct: number;
  /** Minimum distinct NAMES scored. Rows are heavily correlated; names are the honest denominator. */
  minSymbolsScored: number;
  /** Minimum hit rate, percent of scored names where the pick beat SPY. */
  minHitRatePct: number;
}

export interface StrategyVariant {
  id: string;
  description: string;
  /** YYYY-MM-DD. Days BEFORE this are in-sample (the variant was written knowing them); days on or
   *  after are out-of-sample. Reported separately and NEVER merged — see replayVariant. */
  registeredAt: string;
  criteria: PromotionCriteria;
  config: VariantConfig;
  /** MUST be pure: no I/O, no clock, no randomness. Same day in → same picks out. */
  pick(day: VariantDay, config: VariantConfig): VariantPick[];
}

// ── Turning a stored CaptureDay into what a variant sees ─────────────────────

function storedIdxOf(day: CaptureDay, col: string): number | null {
  const stored: readonly string[] = day.columns ?? CAPTURE_COLUMNS;
  const i = stored.indexOf(col);
  return i >= 0 ? i : null;
}

/**
 * Rows a variant is allowed to see. Two filters, both applied CENTRALLY so every variant inherits
 * them and no variant has to remember:
 *
 *  1. No usable price → the row can never be a forward-return baseline, which is the one thing the
 *     capture exists to preserve.
 *  2. Null volatility30d → lib/feature-capture nulls vol when the underlying series was too short,
 *     and its own comment states the other columns on such a row are sentinels that read as "flat
 *     and sitting at its 52-week high" — the strongest possible momentum signal, manufactured out
 *     of missing data. Dropping the row is the only safe reading, and enforcing it here means a
 *     variant cannot accidentally rank on fabricated strength.
 */
function usableRows(day: CaptureDay): FeatureRow[] {
  // Resolved from the STORED list too, not the current constant — same append-only reasoning.
  // These three happen to sit at stable indices today, but deriving them costs nothing and means
  // a future reordering mistake cannot silently read the wrong column as a price.
  const volIdx = storedIdxOf(day, "volatility30d");
  const priceIdx = storedIdxOf(day, "price");
  const symIdx = storedIdxOf(day, "symbol");
  if (volIdx == null || priceIdx == null || symIdx == null) return [];
  // Resolve columns against the STORED column list, not the current one. CAPTURE_COLUMNS is
  // append-only, so an older day legitimately has fewer columns and a new column must read as
  // null there rather than picking up whatever sits at that index. Built ONCE per day, not per row.
  const stored: readonly string[] = day.columns ?? CAPTURE_COLUMNS;
  const storedIdx = new Map<string, number>();
  stored.forEach((c, i) => storedIdx.set(c, i));
  const out: FeatureRow[] = [];
  for (const raw of day.rows ?? []) {
    const symbol = raw[symIdx];
    const price = raw[priceIdx];
    if (typeof symbol !== "string" || !symbol) continue;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    const vol = raw[volIdx];
    if (typeof vol !== "number" || !Number.isFinite(vol)) continue;   // suspect row — see above
    const row: FeatureRow = Object.freeze({
      symbol,
      price,
      get(col: CaptureColumn): number | null {
        const i = storedIdx.get(col);
        if (i == null) return null;                       // column didn't exist on this day
        const v = raw[i];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      },
      sector(): string {
        return STOCK_SECTOR[symbol] ?? "?";
      },
    });
    out.push(row);
  }
  return out;
}

/**
 * Frozen, so a variant that sorts the array IN PLACE (the single likeliest bug in a ranking
 * function — Array.prototype.sort mutates) fails loudly instead of silently corrupting the day for
 * every variant evaluated after it.
 */
export function toVariantDay(day: CaptureDay): VariantDay {
  return Object.freeze({
    date: day.date,
    spyPrice: day.spyPrice ?? null,
    rows: Object.freeze(usableRows(day)),
  });
}

/**
 * Is this day safe to evaluate on? A day where SPY failed to fetch has EVERY relStrength column
 * silently collapsed to the name's own return — "beat the market by exactly its own move" — across
 * all ~500 rows. That is systematic, not per-name noise, so the whole day is excluded rather than
 * quietly poisoning any variant that touches relative strength.
 */
export function isDayUsable(day: CaptureDay): boolean {
  return day.spyAvailable === true && (day.rows?.length ?? 0) > 0;
}

// ── Applying config + running a variant safely ───────────────────────────────

/**
 * Enforce the position and sector caps on whatever the variant returned. Done HERE, not in the
 * variant, for the same reason every buy is capped in code: a limit a strategy applies to itself
 * is not a limit. Order is preserved, so the variant's own conviction ranking decides who survives.
 */
export function applyVariantCaps(picks: VariantPick[], config: VariantConfig): VariantPick[] {
  const out: VariantPick[] = [];
  const perSector: Record<string, number> = {};
  const seen = new Set<string>();
  for (const p of picks) {
    if (out.length >= config.maxPositions) break;
    if (!p?.symbol || seen.has(p.symbol)) continue;        // dedupe: a repeated name is one position
    const sec = STOCK_SECTOR[p.symbol] ?? "?";
    if ((perSector[sec] ?? 0) >= config.maxPerSector) continue;
    out.push(p);
    seen.add(p.symbol);
    perSector[sec] = (perSector[sec] ?? 0) + 1;
  }
  return out;
}

export interface VariantDayResult {
  date: string;
  picks: VariantPick[];
  error?: string;
}

/**
 * Run one variant over one day. FAILS CLOSED: a variant that throws produces NO picks for that day
 * and the error is recorded. It must never fall back to "the whole universe" or to a previous day's
 * picks — either would quietly score a different strategy than the one under test.
 */
export function runVariantDay(variant: StrategyVariant, day: CaptureDay): VariantDayResult {
  if (!isDayUsable(day)) {
    return { date: day.date, picks: [], error: "day excluded (SPY unavailable — relStrength columns are poisoned)" };
  }
  try {
    const vd = toVariantDay(day);
    const raw = variant.pick(vd, variant.config);
    if (!Array.isArray(raw)) return { date: day.date, picks: [], error: "pick() did not return an array" };
    // Only names actually present that day may be picked. A variant returning a symbol it invented
    // (or one carried over from another day) has no capture price, so it could never be scored —
    // and silently dropping it later would understate the variant's position count.
    const present = new Map(vd.rows.map(r => [r.symbol, r]));
    const valid = raw.filter(p => p && typeof p.symbol === "string" && present.has(p.symbol));
    const invented = raw.length - valid.length;
    return {
      date: day.date,
      picks: applyVariantCaps(valid, variant.config),
      error: invented > 0 ? `${invented} pick(s) not in that day's capture — dropped` : undefined,
    };
  } catch (e) {
    return { date: day.date, picks: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Seed variants ────────────────────────────────────────────────────────────

/** Rank helper: sort a COPY, never the frozen input. */
const byDesc = (rows: readonly FeatureRow[], key: (r: FeatureRow) => number | null): FeatureRow[] =>
  [...rows].filter(r => key(r) != null).sort((a, b) => (key(b) as number) - (key(a) as number));

/**
 * THE BASELINE, and the most important variant here: a faithful replay of what the live main book
 * actually screens on — mom12_1 > 0, above-median quality, ranked by 12-1 momentum, 2 per sector.
 * Mirrors buildV1Shortlist (lib/market-data).
 *
 * Its purpose is comparison on IDENTICAL data. "Variant X returned +2%" is unreadable on its own;
 * "variant X beat the live screen by +2% on the same days, same universe, same caps" is the claim
 * the objective actually asks for.
 *
 * KNOWN DIVERGENCE, stated rather than papered over: the live screen's quality gate is an
 * SEC-derived ELIGIBILITY set computed at run time, while the capture stores only qualityPct. Using
 * the median of that day's captured percentile is close but not identical, so treat this as a
 * faithful proxy for the SELECTION RULE, not a bit-exact replay of the live book.
 */
export const LIVE_PROXY: StrategyVariant = {
  id: "live-proxy",
  description: "Faithful proxy of the live main-book screen: mom12_1 > 0, above-median quality, ranked by 12-1 momentum, 2/sector.",
  registeredAt: "2026-09-30",
  criteria: { minExcessReturnPct: 0, minSymbolsScored: 20, minHitRatePct: 50 },
  config: { maxPositions: 6, maxPerSector: 2 },
  pick(day) {
    const q = day.rows.map(r => r.get("qualityPct")).filter((n): n is number => n != null).sort((a, b) => a - b);
    const median = q.length ? q[Math.floor(q.length / 2)] : null;
    const eligible = day.rows.filter(r => {
      const m = r.get("mom12_1");
      const qp = r.get("qualityPct");
      if (m == null || m <= 0) return false;
      if (median == null) return true;               // no quality data that day → momentum only
      return qp != null && qp >= median;
    });
    return byDesc(eligible, r => r.get("mom12_1")).map(r => ({ symbol: r.symbol, score: r.get("mom12_1") ?? 0 }));
  },
};

/**
 * Momentum with a VOLATILITY brake. Same eligibility as the baseline, but ranks on 12-1 momentum
 * divided by 30-day volatility rather than raw momentum — i.e. it prefers the name that got there
 * steadily over the one that got there violently.
 *
 * The hypothesis is specific and falsifiable: the live book's -5.90% alpha came partly from buying
 * high-variance names whose 12-month trend was real but whose short-horizon path was noise. If
 * that is true, this beats the baseline; if the trend is what matters regardless of path, it does
 * not.
 */
export const MOM_PER_VOL: StrategyVariant = {
  id: "mom-per-vol",
  description: "Baseline eligibility, but ranked by 12-1 momentum ÷ 30d volatility — prefers steady trends over violent ones.",
  registeredAt: "2026-09-30",
  criteria: { minExcessReturnPct: 0.5, minSymbolsScored: 20, minHitRatePct: 50 },
  config: { maxPositions: 6, maxPerSector: 2 },
  pick(day) {
    const q = day.rows.map(r => r.get("qualityPct")).filter((n): n is number => n != null).sort((a, b) => a - b);
    const median = q.length ? q[Math.floor(q.length / 2)] : null;
    const eligible = day.rows.filter(r => {
      const m = r.get("mom12_1");
      const qp = r.get("qualityPct");
      if (m == null || m <= 0) return false;
      if (median == null) return true;
      return qp != null && qp >= median;
    });
    return byDesc(eligible, r => {
      const m = r.get("mom12_1"), v = r.get("volatility30d");
      // vol is never 0 here (usableRows drops null-vol rows, and lib/feature-capture nulls the 0
      // sentinel), but guard anyway rather than emit Infinity into a ranking.
      return m == null || v == null || v <= 0 ? null : m / v;
    }).map(r => ({ symbol: r.symbol, score: (r.get("mom12_1") ?? 0) / (r.get("volatility30d") || 1) }));
  },
};

/**
 * Momentum that has NOT already run away. Baseline eligibility, ranked by 12-1 momentum, but
 * excluding names sitting within 2% of their 52-week high.
 *
 * Tests the prompt's own long-standing warning ("do NOT chase names that just spiked") as a
 * mechanical rule rather than a judgment call the model may or may not apply.
 */
export const MOM_NOT_EXTENDED: StrategyVariant = {
  id: "mom-not-extended",
  description: "Baseline eligibility and ranking, excluding names within 2% of their 52-week high.",
  registeredAt: "2026-09-30",
  criteria: { minExcessReturnPct: 0.5, minSymbolsScored: 20, minHitRatePct: 50 },
  config: { maxPositions: 6, maxPerSector: 2 },
  pick(day) {
    const q = day.rows.map(r => r.get("qualityPct")).filter((n): n is number => n != null).sort((a, b) => a - b);
    const median = q.length ? q[Math.floor(q.length / 2)] : null;
    const eligible = day.rows.filter(r => {
      const m = r.get("mom12_1");
      const qp = r.get("qualityPct");
      const dist = r.get("distFrom52wHigh");
      if (m == null || m <= 0) return false;
      // distFrom52wHigh is "% below the 52-week high", so a value near 0 means AT the high.
      if (dist != null && Math.abs(dist) < 2) return false;
      if (median == null) return true;
      return qp != null && qp >= median;
    });
    return byDesc(eligible, r => r.get("mom12_1")).map(r => ({ symbol: r.symbol, score: r.get("mom12_1") ?? 0 }));
  },
};

/** The registry. Adding a variant here is the ONLY thing needed to have it replayed and scored. */
export const VARIANTS: StrategyVariant[] = [LIVE_PROXY, MOM_PER_VOL, MOM_NOT_EXTENDED];

export const BASELINE_VARIANT_ID = LIVE_PROXY.id;

export function getVariant(id: string): StrategyVariant | undefined {
  return VARIANTS.find(v => v.id === id);
}
