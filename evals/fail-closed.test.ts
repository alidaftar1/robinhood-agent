import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeReportDate, screenImminentEarningsBuys, IMMINENT_EARNINGS_DAYS } from "@/lib/earnings";
import { pointsIncludeReport, getValuations, type XbrlPoint } from "@/lib/valuation";
import { formatInfluencerSignals, isInfluencerDowntrend, isSleeveEligible, type MomentumSignal } from "@/lib/influencer-signals";

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED DIRECTION INVARIANTS
//
// Written after a session in which I shipped the SAME defect three times: each
// time I added what I believed was a safety check, and each time it chose the
// fail-OPEN branch. Not one was caught by a test, because every test I wrote
// asserted the happy path and then asked "does it still pass?".
//
// The bug class is not "wrong value", it is "wrong DIRECTION under degradation".
// So these tests assert only direction, over every degraded input: when this
// system cannot establish that a P/E is sound, it must WITHHOLD the number.
// Withholding costs a missed opportunity; publishing a wrong multiple puts real
// money into a name for a reason that is not true. Those are not symmetric, and
// no test here should ever be relaxed to make a feature more "useful".
// ─────────────────────────────────────────────────────────────────────────────

const ptsPrePrint: XbrlPoint[] = [
  { start: "2026-01-01", end: "2026-03-31", val: 1, form: "10-Q", fy: 2026, fp: "Q1", filed: "2026-04-20" },
];

describe("normalizeReportDate never opens the gate", () => {
  // The exact values a vendor can emit. `undefined`/`null`/"" are the ones that bit: they are
  // falsy, and pointsIncludeReport's first line is `if (!reportDate) return true` -> PUBLISHED.
  const degraded = [undefined, null, "", "   ", "N/A", "null", "2026-9-5", "not a date",
                    0, NaN, [], {}, "2026-09-15T00:00:00Z<script>", "9".repeat(5000)];

  for (const raw of degraded) {
    test(`${JSON.stringify(raw)?.slice(0, 32) ?? String(raw)} -> non-falsy, bounded, unreadable`, () => {
      const out = normalizeReportDate(raw);
      expect(out).toBeTruthy();                       // falsy would PUBLISH downstream
      expect(out.length).toBeLessThanOrEqual(12);     // bounded: this reaches the live prompt
      // And it must actually suppress: unreadable by Date.parse means pointsIncludeReport = false.
      expect(pointsIncludeReport(ptsPrePrint, out)).toBe(false);
    });
  }

  test("a real date is passed through unharmed — the guard must not break the normal case", () => {
    expect(normalizeReportDate("2026-09-15")).toBe("2026-09-15");
    expect(normalizeReportDate("2026-09-15T00:00:00")).toBe("2026-09-15");
  });
});

describe("degraded inputs withhold the P/E rather than publish one", () => {
  const priceOf = () => 100;
  const SYM = `ZZFC${process.pid}`;
  const q = (n: number) => {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 3 * n);
    const e = d.toISOString().slice(0, 10);
    const s2 = new Date(d); s2.setUTCMonth(s2.getUTCMonth() - 3);
    return { start: s2.toISOString().slice(0, 10), end: e, val: 2, form: "10-Q", fy: 2026, fp: "Q1", filed: e };
  };
  const good = [q(0), q(1), q(2), q(3)];

  // Each row: a way the world degrades, and the claim that it withholds.
  const cases: Array<[string, Parameters<typeof getValuations>[3], () => Promise<XbrlPoint[]>]> = [
    ["a print whose filing has not landed", { reportedOn: new Map([[SYM, "2099-01-01"]]) }, async () => good],
    ["an unreadable report date", { reportedOn: new Map([[SYM, normalizeReportDate("garbage")]]) }, async () => good],
    ["SEC returning nothing", {}, async () => []],
  ];

  // A SEPARATE symbol per case. Sharing one key let case 1's successful cache write turn case 3
  // into a cache HIT: it never called its own fetchPoints, published, and the invariant went
  // unexercised. Invisible under `bun test` (NODE_ENV=test skips .env.local, so there is no cache
  // at all) and only reachable with creds — i.e. the suite silently stopped testing the thing.
  cases.forEach(([name, opts, fetchPoints], i) => {
    test(name, async () => {
      const sym = `${SYM}X${i}`;
      const remap = opts?.reportedOn
        ? { ...opts, reportedOn: new Map([...opts.reportedOn].map(([, v]) => [sym, v] as const)) }
        : (opts ?? {});
      const ctrl = new AbortController();
      const { valuations } = await getValuations([sym], priceOf, ctrl.signal, { ...remap, fetchPoints });
      expect(valuations.has(sym)).toBe(false);
    });
  });

  test("the CONTROL: undegraded input DOES publish, so the above cannot pass vacuously", async () => {
    const ctrl = new AbortController();
    const sym = `${SYM}CTRL`;
    const { valuations } = await getValuations([sym], priceOf, ctrl.signal, { fetchPoints: async () => good });
    expect(valuations.has(sym)).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// IMMINENT-EARNINGS BUY GATE — same direction rule, on the buy side.
//
// Added 2026-10-13, when the skeptical reviewer asserted that "the imminent-
// earnings screen should block it" for a screen that did not exist: the rule had
// lived only in prompt text. The trap here is identical to normalizeReportDate's
// — a symbol missing from the DATE map means EITHER "nothing reports inside the
// window" OR "the lookup failed", and treating those alike buys blind exactly
// when the data is broken.
// ─────────────────────────────────────────────────────────────────────────────
describe("the imminent-earnings buy gate withholds rather than buying blind", () => {
  const TODAY = "2026-10-14";
  const buys = [{ symbol: "AAA" }];
  const plus = (n: number) =>
    new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  test("a print inside the window is DROPPED, and the note names it as imminent", () => {
    for (let d = 0; d <= IMMINENT_EARNINGS_DAYS; d++) {
      const r = screenImminentEarningsBuys(buys, { AAA: plus(d) }, new Set(["AAA"]), TODAY);
      expect(r.kept).toHaveLength(0);
      expect(r.imminent).toEqual(["AAA"]);
      expect(r.notes[0]).toContain("IMMINENT EARNINGS");
      expect(r.notes[0]).toContain("DROPPED");
    }
  });

  test("a symbol we could NOT ask about is DROPPED — absence of a date is not absence of risk", () => {
    // The fail-OPEN branch: `dates` has no entry, so a screen keyed on dates alone keeps the buy.
    const r = screenImminentEarningsBuys(buys, {}, new Set(), TODAY);
    expect(r.kept).toHaveLength(0);
    expect(r.unknown).toEqual(["AAA"]);
  });

  test("an UNPARSEABLE date is withheld too, not read as 'far away'", () => {
    const r = screenImminentEarningsBuys(buys, { AAA: "not-a-date" }, new Set(["AAA"]), TODAY);
    expect(r.kept).toHaveLength(0);
    expect(r.unknown).toEqual(["AAA"]);
  });

  test("the two notes make DIFFERENT claims — one about the company, one about us", () => {
    const imm = screenImminentEarningsBuys(buys, { AAA: plus(1) }, new Set(["AAA"]), TODAY).notes[0];
    const unk = screenImminentEarningsBuys(buys, {}, new Set(), TODAY).notes[0];
    expect(imm).not.toBe(unk);
    // The unknown note must NOT assert a print; it asserts only that we could not establish one.
    expect(unk).toMatch(/could NOT establish|not be parsed/);
    expect(unk).toContain("NOT that AAA is reporting");
    expect(unk).not.toContain("IMMINENT EARNINGS");
  });

  test("CONTROLS: undegraded input still BUYS, so the gate cannot pass by rejecting everything", () => {
    // (a) asked, and the print is beyond the window.
    const far = screenImminentEarningsBuys(buys, { AAA: plus(IMMINENT_EARNINGS_DAYS + 1) }, new Set(["AAA"]), TODAY);
    expect(far.kept).toHaveLength(1);
    expect(far.notes).toHaveLength(0);
    // (b) asked, and nothing reports inside the 30-day window at all — the ordinary case for most
    //     names. This is the one "no date" that is an ANSWER, and it must not be withheld.
    const none = screenImminentEarningsBuys(buys, {}, new Set(["AAA"]), TODAY);
    expect(none.kept).toHaveLength(1);
    expect(none.notes).toHaveLength(0);
    // (c) a PAST date is not imminent — it already happened.
    const past = screenImminentEarningsBuys(buys, { AAA: plus(-1) }, new Set(["AAA"]), TODAY);
    expect(past.kept).toHaveLength(1);
  });

  test("the screen is per-symbol: one blocked name does not take the others down", () => {
    const many = [{ symbol: "AAA" }, { symbol: "BBB" }, { symbol: "CCC" }];
    const r = screenImminentEarningsBuys(
      many,
      { AAA: plus(1), BBB: plus(20) },
      new Set(["AAA", "BBB"]),        // CCC was never answered for
      TODAY,
    );
    expect(r.kept.map(b => b.symbol)).toEqual(["BBB"]);
    expect(r.imminent).toEqual(["AAA"]);
    expect(r.unknown).toEqual(["CCC"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SLEEVE BUY UNIVERSE — a universe rule must REMOVE a candidate, not starve it
//
// 2026-10-22. Sleeve buys were restricted to S&P 500 members on 2026-10-04, but
// the restriction was implemented only inside fetchMomentum, which returns null
// for an off-index symbol. That does not remove the name from anything — it
// blanks its price and momentum. The name was still extracted, still rendered to
// the model as a candidate, and still in the buy-allowlist; the one thing that
// changed was that every price-trend screen lost its input, and each of those
// screens treats a missing reading as a pass (isInfluencerDowntrend(undefined)
// === false). The per-position cap is dollar-based, so it passed too.
//
// The model then chose SPCX — net=7, the run's TOP-ranked name, off index, no
// price — and justified it with "no ⛔DOWNTREND, no imminent earnings shown".
// Absence of data read to it as absence of risk. The order was stopped only by
// the unrelated sector-budget gate, which had shipped 8 days earlier; in the
// 10 days before that, nothing downstream would have stopped it.
//
// Same canonical trap as the normalizeReportDate cases above: dropping a bad
// input is the fail-OPEN branch, because "absent" means "unconstrained".
// ─────────────────────────────────────────────────────────────────────────────
describe("sleeve buy universe fails closed", () => {
  // Select the rendered DATA row, not prose that merely names the ticker — the prompt body
  // discusses tickers too, and matching it made an earlier draft of these tests assert against
  // an instruction line instead of the row under test.
  const dataRow = (section: string, ticker: string) =>
    section.split("\n").find(l => /^(?:🔥|📺)/.test(l) && l.includes(ticker))!;

  const momOf = (m: Partial<MomentumSignal> = {}) =>
    ({ change1d: 1, change5d: 3, distFromHigh: -2, aboveShortMA: true, ...m }) as MomentumSignal;

  // The exact shape of the 2026-10-22 run: the off-index names OUTRANK the index ones,
  // so a filter applied after the ranking slice would still surface them.
  const liveShape = {
    refreshedAt: "2026-10-22",
    signals: [
      { tickers: ["SPCX"], channelName: "Meet Kevin", confidence: "high" },
      { tickers: ["TSM"], channelName: "Tom Nash", confidence: "high" },
      { tickers: ["PLTR"], channelName: "Ticker Symbol YOU", confidence: "high" },
      // A second channel, so PLTR clears the two-channel bar (2026-10-29) and the CONTROL below still
      // isolates the momentum marker rather than tripping over the corroboration marker.
      { tickers: ["PLTR"], channelName: "Meet Kevin", confidence: "medium" },
    ],
    tickerCounts: { SPCX: 7, TSM: 3, PLTR: 4 },
    avoidCounts: {},
  } as any;

  test("the predicate itself: index membership decides sleeve eligibility", () => {
    expect(isSleeveEligible("PLTR")).toBe(true);   // in the index
    expect(isSleeveEligible("SPCX")).toBe(false);  // Nasdaq listing, never in the index
    expect(isSleeveEligible("TSM")).toBe(false);   // foreign ADR
  });

  test("an off-index name is NOT shown to the model, however high its consensus", () => {
    const section = formatInfluencerSignals(
      liveShape,
      new Map([["PLTR", 180]]),
      new Map([["PLTR", momOf()]]),
    );
    // net=7 was the highest score in the run and must still not appear.
    expect(section).not.toContain("SPCX");
    expect(section).not.toContain("TSM");
  });

  // CONTROL — the suite must not be able to pass by rejecting everything. This is the
  // companion to the "UNDEGRADED input still publishes" control above.
  test("CONTROL: the in-index name IS still shown, with its reading", () => {
    const section = formatInfluencerSignals(
      liveShape,
      new Map([["PLTR", 180]]),
      new Map([["PLTR", momOf()]]),
    );
    expect(section).toContain("PLTR");
    expect(section).toContain("net=4");
  });

  test("an in-index name with NO momentum reading is marked NOT BUYABLE, not left blank", () => {
    // The failure that survives the universe fix: an eligible name whose fetch timed out.
    // Rendered blank it reads as a clean screen — which is how SPCX was justified.
    const section = formatInfluencerSignals(
      liveShape,
      new Map(),
      new Map(),          // the screen was ATTEMPTED and produced nothing for PLTR
    );
    const row = dataRow(section, "PLTR");
    expect(row).toContain("NOT BUYABLE");
  });

  test("CONTROL: a name WITH a clean reading carries no NOT-BUYABLE marker", () => {
    const section = formatInfluencerSignals(
      liveShape,
      new Map([["PLTR", 180]]),
      new Map([["PLTR", momOf()]]),
    );
    const row = dataRow(section, "PLTR");
    expect(row).not.toContain("NOT BUYABLE");
    expect(row).toContain("5d:+3%");
  });

  test("a missing reading is not silently a PASS of the downtrend screen", () => {
    // The root predicate. It returns false for undefined, which is correct for a DISPLAY
    // tag but must never be read as "screened and cleared" by a buy decision — hence the
    // route's data gate drops an unpriced sleeve buy instead of consulting this.
    expect(isInfluencerDowntrend(undefined)).toBe(false);
    expect(isInfluencerDowntrend(momOf({ change5d: -20, distFromHigh: -30, aboveShortMA: false }))).toBe(true);
  });

  // The route's data gate decides on three inputs. The gate itself lives in a route handler, so
  // (as with evals/main-position-cap.test.ts) pin the DECISION it relies on. The third case is the
  // one an earlier draft of this fix got wrong: it withheld a main-rails buy for lacking an entry
  // in a map that only ever holds sleeve candidates — withholding for a reason that is not true,
  // which is its own direction bug, not a safe default.
  const dropsAsUnpriced = (a: { sleeve: boolean; onShortlist: boolean; hasMomentum: boolean }) =>
    a.sleeve && !a.onShortlist && !a.hasMomentum;

  test("the data gate drops an unpriced SLEEVE pick", () => {
    expect(dropsAsUnpriced({ sleeve: true, onShortlist: false, hasMomentum: false })).toBe(true);
  });

  test("it does NOT drop a sleeve pick whose momentum resolved", () => {
    expect(dropsAsUnpriced({ sleeve: true, onShortlist: false, hasMomentum: true })).toBe(false);
  });

  test("it does NOT drop a name the MAIN rails screened, even tagged influencer", () => {
    // MU/TGT are in both lists. The main shortlist carries its own price and quality screen.
    expect(dropsAsUnpriced({ sleeve: true, onShortlist: true, hasMomentum: false })).toBe(false);
  });

  test("it never touches an ordinary main buy", () => {
    expect(dropsAsUnpriced({ sleeve: false, onShortlist: true, hasMomentum: false })).toBe(false);
    expect(dropsAsUnpriced({ sleeve: false, onShortlist: false, hasMomentum: false })).toBe(false);
  });

  // COUPLING CHECK. The candidate sets in app/api/trade/route.ts are built in a route handler and
  // are not reachable from a unit test, but they are the lists the model actually buys from. The
  // whole defect was those lists and the SHOWN list disagreeing, so assert BOTH copies (the real
  // path and the dry-run preview) are keyed to the same exported predicate, and that each applies
  // it before its ranking slice. Asserting presence separately from ordering matters: an
  // indexOf-only check passes vacuously at -1 once the filter is gone.
  test("both route candidate paths filter by the same predicate, before slicing", () => {
    const src = readFileSync(`${import.meta.dir}/../app/api/trade/route.ts`, "utf8");
    const calls = src.split("isSleeveEligible").length - 1;
    expect(calls).toBeGreaterThanOrEqual(3);          // 1 import + the real path + the dry-run path

    // Each candidate declaration must filter, and must do so BEFORE its slice.
    for (const marker of ["const topInfluencerTickers", "const topTickers"]) {
      const at = src.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const decl = src.slice(at, src.indexOf(".slice(", at));
      expect(decl).toContain("isSleeveEligible");     // present, not merely ordered
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SLEEVE BASE: the owner's between-run flows may only ever UNDERSTATE a sleeve day.
// 2026-11-23 stored main +12.24% (true +7.59%) because the owner's buys earned gain with no base;
// the first fix then start-weighted owner SELLS, which shrank the base and inflated (review).
// Mutation-checked: dropping the buy cost from the base, or subtracting sell proceeds, fails these.
// ─────────────────────────────────────────────────────────────────────────────
import { computeSleeveReturns, type PositionSnapshot as PS, type TradeSnapshot as TS } from "@/lib/run-store";
describe("sleeve base never shrinks or omits owner capital", () => {
  const p = (symbol: string, quantity: string, price: string): PS => ({ symbol, quantity, price, avgCost: price });
  const t = (side: string, symbol: string, quantity: string, avgPrice: string, actor?: TS["actor"]): TS =>
    ({ symbol, side, quantity, avgPrice, state: "filled", strategy: "main", ...(actor ? { actor } : {}) });
  const main = (today: PS[], tr: TS[], yst: PS[]) => computeSleeveReturns(today, tr, [], [], yst).mainDailyReturn;

  test("owner sells a winner late in the window: not divided by the shrunken remainder", () => {
    // A $800 + B $200; A rises 5% and the owner sells it for $840; B flat. True ≈ +4%, fail-open read +25%.
    const r = main([p("B", "1", "200")], [t("sell", "A", "1", "840", "human")], [p("A", "1", "800"), p("B", "1", "200")]);
    expect(r!).toBeLessThanOrEqual(0.04 + 1e-9);
  });

  test("owner buys between runs: their gain is not counted against a base that excludes their cost", () => {
    // $1000 book flat; owner buys $1000 of C that rises 10%. True ≈ +5%, fail-open read +10%.
    const r = main([p("A", "1", "1000"), p("C", "1", "1100")], [t("buy", "C", "1", "1000", "human")], [p("A", "1", "1000")]);
    expect(r!).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  test("owner buy with no price and no position to mark it from: withheld, not a $0 cost", () => {
    expect(main([p("A", "1", "1000")], [t("buy", "C", "1", "", "human")], [p("A", "1", "1000")])).toBeNull();
  });

  test("control: an undegraded agent-only day still publishes", () => {
    expect(main([p("A", "1", "1010")], [], [p("A", "1", "1000")])).toBeCloseTo(0.01, 6);
  });
});

describe("owner buy with an unreadable quantity is withheld, not a $0 cost", () => {
  const p = (symbol: string, quantity: string, price: string): PS => ({ symbol, quantity, price, avgCost: price });
  test("quantity \"\" on a captured owner buy", () => {
    const r = computeSleeveReturns([p("A", "1", "1000"), p("C", "1", "1100")],
      [{ symbol: "C", side: "buy", quantity: "", avgPrice: "1000", state: "filled", strategy: "main", actor: "human" }], [], [], [p("A", "1", "1000")]);
    expect(r.mainDailyReturn).toBeNull();
  });
});

// ─── An unmeasured daily move is neither a stop nor a calm day (2026-11-24 SNDK) ──────────────
// After SNDK's 8:1 split Yahoo blanked its closes; the prior-close fallback took the last non-null
// (pre-split) close and the drop-check sold on "-17.7%" a day that was really -11.6%.
import { resolvePrevClose as _rpc } from "@/lib/market-data";
import { screenMeanReversionCandidates as _mr } from "@/lib/mean-reversion";
describe("an unmeasured previous close is withheld, never guessed or zeroed", () => {
  const ts = (d: string) => Date.parse(`${d}T14:30:00Z`) / 1000;
  const at = { regularMarketTime: Date.parse("2026-11-24T18:00:00Z") / 1000 };
  test("blank prior bar → null, not the older close", () => {
    expect(_rpc(at, [ts("2026-11-19"), ts("2026-11-23"), ts("2026-11-24")], [94.39, null, 77.55])).toBeNull();
    expect(_rpc(at, [ts("2026-11-19"), ts("2026-11-24")], [94.39, 77.55])).toBeNull();
  });
  test("a blank duplicate row for the session does not hide a valid one", () => {
    expect(_rpc(at, [ts("2026-11-23"), Date.parse("2026-11-23T21:00:00Z") / 1000, ts("2026-11-24")], [87.71, null, 77.55])).toBe(87.71);
  });
  test("misaligned arrays → null", () => {
    expect(_rpc(at, [ts("2026-11-23"), ts("2026-11-24")], [87.71])).toBeNull();
  });
  test("control: the real prior close is used", () => {
    expect(_rpc(at, [ts("2026-11-23"), ts("2026-11-24")], [87.71, 77.55])).toBe(87.71);
  });
  const row = (o: Record<string, unknown>) => ({ symbol: "X", price: 100, change1d: 0, change5d: -12, change14d: 0, change30d: 0,
    distFrom52wHigh: -30, volatility30d: 30, sharpe5d: 0, sharpe14d: 0, sharpe30d: 0, mom12_1: 10, beta: 1, earningsDate: null,
    relStrength1d: 0, relStrength5d: 0, relStrength14d: 0, ...o }) as any;
  test("mean-reversion does not read an unmeasured day as 'stabilizing'", () => {
    const run = (s: any) => _mr([s], new Set(["X"]), () => 0.8, () => false).length;
    expect(run(row({ change1dUnknown: true }))).toBe(0);
    expect(run(row({}))).toBe(1); // control
  });
});

// ─── Robinhood's previous close: trusted only when dated, positive, and matched ────────────
import { robinhoodPrevCloses as _rh } from "@/lib/robinhood-balance";
describe("a second-source previous close is checked before it can fire a stop", () => {
  const row = (o: Record<string, unknown> = {}) => ({ symbol: "SNDK", adjustedPreviousClose: "73.610000", previousCloseDate: "2026-11-25",
    lastTradePrice: "83.358200", state: "active", ...o });
  const run = (rows: any[], price: number | null = 83.29) => _rh(rows, ["SNDK"], "2026-11-25", () => price).get("SNDK");
  test("control: the real 2026-11-27 SNDK row is used", () => expect(run([row()])).toBe(73.61));
  test("wrong date, zero, junk, halted → not used", () => {
    expect(run([row({ previousCloseDate: "2026-11-24" })])).toBeUndefined();
    expect(run([row({ adjustedPreviousClose: "0" })])).toBeUndefined();
    expect(run([row({ adjustedPreviousClose: "n/a" })])).toBeUndefined();
    expect(run([row({ state: "halted" })])).toBeUndefined();
  });
  test("a row whose last trade is not this symbol's price (a mis-copied row) → not used", () => {
    expect(run([row({ lastTradePrice: "640.01" })])).toBeUndefined();
    expect(run([row({ lastTradePrice: "75.5" })])).toBe(73.61); // a crash moving during the call is still this row
    expect(run([row({ lastTradePrice: "" })])).toBeUndefined();
  });
  test("conflicting duplicate rows → not used; an unwanted symbol is ignored", () => {
    expect(run([row(), row({ adjustedPreviousClose: "94.39" })])).toBeUndefined();
    expect(_rh([row({ symbol: "MU" })], ["SNDK"], "2026-11-25", () => 83).size).toBe(0);
  });
});

// ─── patchDate refuses a book that does not add up, unless the owner unlocks ───────────────
import { dayReturnFromMerged as _dr } from "@/lib/run-store";
describe("a recompute of a withheld day does not publish from an unreconciled book", () => {
  const run = (date: string, positions: any[], trades: any[] = [], total = "1000") => ({ date, timestamp: `${date}T15:30:00.000Z`,
    summary: "", positions, trades, influencerPositions: [], personal: null, portfolioAfter: { totalValue: total, cash: "0", equity: total } }) as any;
  const p = (symbol: string, quantity: string, price: string) => ({ symbol, quantity, price, avgCost: price });
  const prev = run("2026-11-24", [p("A", "10", "100")]);
  const ghost = run("2026-11-25", [p("A", "12", "100")], [], "1200");   // 2 shares appeared, no record
  test("required: refuses", () => expect(_dr([ghost, prev], "2026-11-25", true).ok).toBe(false));
  test("not required (unlock): computes", () => expect(_dr([ghost, prev], "2026-11-25", false).ok).toBe(true));
  test("control: a book that adds up is computed even when required", () => {
    const fine = run("2026-11-25", [p("A", "12", "100")], [{ symbol: "A", side: "buy", quantity: "2", avgPrice: "100", state: "filled" }], "1200");
    expect(_dr([fine, prev], "2026-11-25", true).ok).toBe(true);
  });
  test("a day patchTrades already repaired (inferred sell on record) is computed", () => {
    const sold = run("2026-11-25", [p("A", "6", "100")], [{ symbol: "A", side: "sell", quantity: "4.000000", avgPrice: "100.00", state: "inferred" }], "1000");
    expect(_dr([sold, prev], "2026-11-25", true).ok).toBe(true);
    const short = run("2026-11-25", [p("A", "6", "100")], [], "1000"); // same day before the repair
    expect(_dr([short, prev], "2026-11-25", true).ok).toBe(false);
  });
  test("wired: patchDate's bypass is its own switch, not unlock; the 8am job raises a refusal", () => {
    const d = readFileSync(new URL("../app/api/debug/route.ts", import.meta.url), "utf8");
    expect(d).toContain("recomputeDayReturn(date, { unlock, writeIfNone: true, requireReconciled: !unreconciled })");
    expect(d).not.toContain("requireReconciled: !unlock");
    const a = readFileSync(new URL("../app/api/autopilot/route.ts", import.meta.url), "utf8");
    expect(a.indexOf("result?.patchDateRefused === true")).toBeGreaterThan(-1);
    expect(a.slice(a.indexOf("result?.patchDateRefused === true"), a.indexOf("result?.patchDateRefused === true") + 200)).toContain("issues.push(");
  });
});
