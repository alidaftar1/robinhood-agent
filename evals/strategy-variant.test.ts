import { describe, test, expect } from "bun:test";
import {
  clampVariantConfig, describeConfigClamp, VARIANT_CONFIG_BOUNDS,
  applyVariantCaps, runVariantDay, toVariantDay, isDayUsable,
  LIVE_PROXY, MOM_NOT_EXTENDED, VARIANTS,
  type StrategyVariant,
} from "@/lib/strategy-variant";
import { CAPTURE_COLUMNS, type CaptureDay } from "@/lib/feature-capture";

// A variant is a PURE FUNCTION over captured features — that is the entire containment story, so
// these tests are about the BOUNDARY, not about whether any particular strategy is good. What must
// hold: a variant cannot exceed its caps, cannot pick a name that wasn't there, cannot poison the
// day for the next variant, and cannot rank on data the capture marked as broken.

const col = (name: string) => CAPTURE_COLUMNS.indexOf(name as never);

/** Build one capture row with sane defaults, overriding by column name. */
function row(symbol: string, over: Record<string, number | null> = {}): Array<string | number | null> {
  const r: Array<string | number | null> = CAPTURE_COLUMNS.map(() => null);
  r[col("symbol")] = symbol;
  r[col("price")] = 100;
  r[col("volatility30d")] = 25;     // non-null → row is usable
  r[col("mom12_1")] = 10;
  r[col("qualityPct")] = 0.9;
  r[col("distFrom52wHigh")] = -20;
  for (const [k, v] of Object.entries(over)) {
    const i = col(k);
    if (i >= 0) r[i] = v;
  }
  return r;
}

function day(rows: Array<Array<string | number | null>>, over: Partial<CaptureDay> = {}): CaptureDay {
  return {
    v: 1, date: "2026-10-05", capturedAt: "2026-10-05T14:30:00Z",
    spyAvailable: true, spyPrice: 500,
    columns: CAPTURE_COLUMNS, rows, ...over,
  };
}

describe("variant config envelope: the agent picks inside it, code owns it", () => {
  test("clamps out-of-range parameters instead of honouring or crashing on them", () => {
    const c = clampVariantConfig({ maxPositions: 50, maxPerSector: 99 });
    expect(c.maxPositions).toBe(VARIANT_CONFIG_BOUNDS.maxPositions[1]);
    expect(c.maxPerSector).toBe(VARIANT_CONFIG_BOUNDS.maxPerSector[1]);
    const lo = clampVariantConfig({ maxPositions: 0, maxPerSector: 0 });
    expect(lo.maxPositions).toBe(VARIANT_CONFIG_BOUNDS.maxPositions[0]);
    expect(lo.maxPerSector).toBe(VARIANT_CONFIG_BOUNDS.maxPerSector[0]);
  });

  test("a clamp is REPORTED — a variant running at parameters it did not ask for must say so", () => {
    const requested = { maxPositions: 50, maxPerSector: 2 };
    const applied = clampVariantConfig(requested);
    const notes = describeConfigClamp(requested, applied);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("maxPositions 50 → 12");
    // Nothing to report when the request was already inside the envelope. Note this must compare
    // a request against ITS OWN clamp — comparing it to some other config would report a phantom.
    const inRange = { maxPositions: 6, maxPerSector: 2 };
    expect(describeConfigClamp(inRange, clampVariantConfig(inRange))).toEqual([]);
  });

  test("NaN and undefined fall back to the floor rather than producing NaN caps", () => {
    expect(clampVariantConfig({ maxPositions: NaN }).maxPositions).toBe(VARIANT_CONFIG_BOUNDS.maxPositions[0]);
    expect(Number.isFinite(clampVariantConfig(undefined).maxPositions)).toBe(true);
  });
});

describe("caps are enforced on the variant's OUTPUT, not inside the variant", () => {
  // A limit a strategy applies to itself is not a limit — same reason every buy is capped in code.
  const greedy: StrategyVariant = {
    id: "greedy", description: "returns everything, ignores every cap",
    registeredAt: "2026-01-01",
    criteria: { minExcessReturnPct: 0, minSymbolsScored: 1, minHitRatePct: 0 },
    config: { maxPositions: 3, maxPerSector: 1 },
    pick: (d) => d.rows.map(r => ({ symbol: r.symbol })),
  };

  test("a variant that returns the whole universe is cut to maxPositions", () => {
    const d = day([row("AAPL"), row("MSFT"), row("NVDA"), row("JPM"), row("XOM"), row("KO")]);
    const res = runVariantDay(greedy, d);
    expect(res.picks.length).toBeLessThanOrEqual(greedy.config.maxPositions);
  });

  test("the per-sector cap binds even when the variant ignores sectors entirely", () => {
    // AAPL, MSFT, NVDA are all XLK. maxPerSector 1 → at most one of them survives.
    const d = day([row("AAPL"), row("MSFT"), row("NVDA")]);
    const res = runVariantDay(greedy, d);
    expect(res.picks.length).toBe(1);
  });

  test("a duplicated symbol counts once — a repeated name is one position, not two", () => {
    const picks = applyVariantCaps(
      [{ symbol: "AAPL" }, { symbol: "AAPL" }, { symbol: "JPM" }],
      { maxPositions: 6, maxPerSector: 2 },
    );
    expect(picks.map(p => p.symbol)).toEqual(["AAPL", "JPM"]);
  });

  test("caps preserve the variant's own conviction order — the cap decides WHO survives, not the rank", () => {
    const picks = applyVariantCaps(
      [{ symbol: "JPM", score: 9 }, { symbol: "AAPL", score: 5 }],
      { maxPositions: 1, maxPerSector: 2 },
    );
    expect(picks[0].symbol).toBe("JPM");
  });
});

describe("a variant cannot corrupt the substrate or invent data", () => {
  test("a variant that sorts the rows IN PLACE fails loudly instead of poisoning later variants", () => {
    // Array.prototype.sort mutates — the single likeliest bug in a ranking function. The frozen
    // rows array turns that into a caught error for THIS variant rather than silent cross-variant
    // contamination, which would be near-impossible to diagnose from the results.
    const mutating: StrategyVariant = {
      id: "mutating", description: "sorts its input in place",
      registeredAt: "2026-01-01",
      criteria: { minExcessReturnPct: 0, minSymbolsScored: 1, minHitRatePct: 0 },
      config: { maxPositions: 6, maxPerSector: 2 },
      pick: (d) => {
        (d.rows as unknown as Array<unknown>).sort();     // mutation attempt
        return d.rows.map(r => ({ symbol: r.symbol }));
      },
    };
    const res = runVariantDay(mutating, day([row("AAPL"), row("MSFT")]));
    expect(res.picks).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  test("a variant that throws yields NO picks — never a fallback to the whole universe", () => {
    const boom: StrategyVariant = {
      id: "boom", description: "throws",
      registeredAt: "2026-01-01",
      criteria: { minExcessReturnPct: 0, minSymbolsScored: 1, minHitRatePct: 0 },
      config: { maxPositions: 6, maxPerSector: 2 },
      pick: () => { throw new Error("kaboom"); },
    };
    const res = runVariantDay(boom, day([row("AAPL")]));
    expect(res.picks).toEqual([]);
    expect(res.error).toContain("kaboom");
  });

  test("a symbol that was not in that day's capture is dropped and reported", () => {
    const inventor: StrategyVariant = {
      id: "inventor", description: "returns a name that isn't there",
      registeredAt: "2026-01-01",
      criteria: { minExcessReturnPct: 0, minSymbolsScored: 1, minHitRatePct: 0 },
      config: { maxPositions: 6, maxPerSector: 2 },
      pick: () => [{ symbol: "AAPL" }, { symbol: "NOTREAL" }],
    };
    const res = runVariantDay(inventor, day([row("AAPL")]));
    expect(res.picks.map(p => p.symbol)).toEqual(["AAPL"]);
    expect(res.error).toContain("not in that day's capture");
  });
});

describe("poisoned data is excluded centrally, so no variant has to remember", () => {
  test("a day where SPY was unavailable is excluded whole", () => {
    // lib/feature-capture: on a SPY fetch failure EVERY relStrength column silently becomes the
    // name's own return across all ~500 rows — systematic, not per-name noise.
    const d = day([row("AAPL")], { spyAvailable: false });
    expect(isDayUsable(d)).toBe(false);
    const res = runVariantDay(LIVE_PROXY, d);
    expect(res.picks).toEqual([]);
    expect(res.error).toContain("SPY unavailable");
  });

  test("a null-volatility row is dropped — its other columns read as fabricated strength", () => {
    // feature-capture nulls vol when the series was too short, and says the other columns on such
    // a row are sentinels reading as "flat and at its 52-week high" — the strongest possible
    // momentum signal, manufactured from missing data.
    const vd = toVariantDay(day([row("AAPL"), row("MSFT", { volatility30d: null })]));
    expect(vd.rows.map(r => r.symbol)).toEqual(["AAPL"]);
  });

  test("a row with no usable price is dropped — it could never be a forward-return baseline", () => {
    const vd = toVariantDay(day([row("AAPL"), row("MSFT", { price: 0 })]));
    expect(vd.rows.map(r => r.symbol)).toEqual(["AAPL"]);
  });

  test("a column absent on an older day reads as null, not as whatever sits at that index", () => {
    // CAPTURE_COLUMNS is append-only; an older day has fewer columns. Resolving by the CURRENT
    // list would silently re-label history.
    const older = day([["AAPL", 100, 12, 25]], { columns: ["symbol", "price", "mom12_1", "volatility30d"] });
    const vd = toVariantDay(older);
    expect(vd.rows[0].get("mom12_1")).toBe(12);
    expect(vd.rows[0].get("qualityPct")).toBeNull();   // did not exist that day
  });
});

describe("the seed variants express what they claim", () => {
  test("live-proxy requires positive 12-1 momentum and above-median quality", () => {
    const d = day([
      row("AAPL", { mom12_1: 30, qualityPct: 0.9 }),
      row("XOM", { mom12_1: -5, qualityPct: 0.9 }),    // negative momentum → excluded
      row("KO", { mom12_1: 20, qualityPct: 0.1 }),     // below-median quality → excluded
      row("JPM", { mom12_1: 25, qualityPct: 0.8 }),
    ]);
    const picks = runVariantDay(LIVE_PROXY, d).picks.map(p => p.symbol);
    expect(picks).not.toContain("XOM");
    expect(picks).not.toContain("KO");
    expect(picks[0]).toBe("AAPL");                      // ranked by momentum
  });

  test("mom-not-extended excludes a name sitting at its 52-week high", () => {
    const d = day([
      row("AAPL", { mom12_1: 30, distFrom52wHigh: -0.5 }),  // at the high → excluded
      row("JPM", { mom12_1: 25, distFrom52wHigh: -20 }),
    ]);
    const picks = runVariantDay(MOM_NOT_EXTENDED, d).picks.map(p => p.symbol);
    expect(picks).toEqual(["JPM"]);
    // Control: the baseline, which has no such rule, still takes AAPL first.
    expect(runVariantDay(LIVE_PROXY, d).picks[0].symbol).toBe("AAPL");
  });

  test("every registered variant has a unique id and a pre-registration date", () => {
    const ids = VARIANTS.map(v => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VARIANTS) {
      expect(v.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.criteria.minSymbolsScored).toBeGreaterThan(0);
    }
  });

  test("seed variants are PURE — the same day twice yields identical picks", () => {
    const d = day([row("AAPL", { mom12_1: 30 }), row("JPM", { mom12_1: 25 }), row("XOM", { mom12_1: 20 })]);
    for (const v of VARIANTS) {
      const a = runVariantDay(v, d).picks.map(p => p.symbol);
      const b = runVariantDay(v, d).picks.map(p => p.symbol);
      expect(a).toEqual(b);
    }
  });
});

// ── The Upstash pipeline response shape ──────────────────────────────────────
// This has bitten the repo before: `/pipeline` returns a TOP-LEVEL ARRAY while every other endpoint
// returns `{result}`. Reading it wrong yields undefined per entry, which here would look exactly
// like "no capture days stored yet" rather than like a bug — a silent empty replay.
describe("capture-day pipeline parsing degrades to skipping, never to an empty universe", () => {
  const dayJson = (date: string) => JSON.stringify({
    v: 1, date, capturedAt: `${date}T14:30:00Z`, spyAvailable: true, spyPrice: 500,
    columns: CAPTURE_COLUMNS, rows: [row("AAPL")],
  });

  test("reads the {result} entry shape", async () => {
    const { parseCaptureDaysResponse } = await import("@/lib/variant-replay");
    const out = parseCaptureDaysResponse([{ result: dayJson("2026-10-01") }, { result: null }]);
    expect(out.map(d => d.date)).toEqual(["2026-10-01"]);
  });

  test("reads the bare-string entry shape too", async () => {
    const { parseCaptureDaysResponse } = await import("@/lib/variant-replay");
    const out = parseCaptureDaysResponse([dayJson("2026-10-02"), null]);
    expect(out.map(d => d.date)).toEqual(["2026-10-02"]);
  });

  test("returns days in ASCENDING date order regardless of input order", async () => {
    const { parseCaptureDaysResponse } = await import("@/lib/variant-replay");
    const out = parseCaptureDaysResponse([dayJson("2026-10-03"), dayJson("2026-10-01")]);
    expect(out.map(d => d.date)).toEqual(["2026-10-01", "2026-10-03"]);
  });

  test("skips malformed, truncated, and row-less days WHOLE rather than trusting them partially", async () => {
    const { parseCaptureDaysResponse } = await import("@/lib/variant-replay");
    const out = parseCaptureDaysResponse([
      "{not json",
      JSON.stringify({ v: 1, date: "2026-10-04", columns: CAPTURE_COLUMNS }),   // no rows
      JSON.stringify({ v: 1, date: "2026-10-05", columns: CAPTURE_COLUMNS, rows: [] }), // empty rows
      { result: dayJson("2026-10-06") },
    ]);
    expect(out.map(d => d.date)).toEqual(["2026-10-06"]);
  });

  test("a non-array response yields no days rather than throwing", async () => {
    const { parseCaptureDaysResponse } = await import("@/lib/variant-replay");
    expect(parseCaptureDaysResponse({ result: "whatever" })).toEqual([]);
    expect(parseCaptureDaysResponse(null)).toEqual([]);
  });
});
