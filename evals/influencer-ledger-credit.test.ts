import { describe, expect, test } from "bun:test";
import { rollupChannels, migratedChannelEntries, type PickOutcome, type LedgerPick } from "../lib/influencer-ledger";
import type { DatedBars } from "../lib/market-data";

// THE BUG THIS GUARDS: every channel listed on a ticker used to be credited with the ticker's
// ENTIRE return since its first sighting. A channel that mentioned an already-logged winner
// inherited the whole prior run-up, which systematically rewarded channels for talking about names
// that were already working. A channel must be credited only from ITS OWN first mention forward.

function pick(over: Partial<PickOutcome> = {}): PickOutcome {
  return {
    ticker: "NVDA",
    channels: ["Early", "Late"],
    maxScore: 4,
    maxConfidence: "high",
    firstSeenDate: "2026-09-01",
    lastSeenDate: "2026-10-01",
    priceAtSignal: 100,
    currentPrice: 150,
    returnPct: 50,
    marketReturnPct: 10,
    alphaPct: 40,
    daysElapsed: 30,
    channelEntries: {
      Early: { firstSeenDate: "2026-09-01", priceAtSignal: 100 },
      Late: { firstSeenDate: "2026-09-25", priceAtSignal: 140 },
    },
    ...over,
  };
}

const spy = new Map([["2026-09-01", 500], ["2026-09-25", 540]]);

describe("rollupChannels — per-channel credit", () => {
  test("a late mention is credited from ITS OWN baseline, not the ticker's", () => {
    const [a, b] = rollupChannels([pick()], spy, 550);
    const early = [a, b].find(c => c.channel === "Early")!;
    const late = [a, b].find(c => c.channel === "Late")!;
    expect(early.avgReturnPct).toBeCloseTo(50, 5);   // 100 -> 150
    expect(late.avgReturnPct).toBeCloseTo(7.142857, 4); // 140 -> 150, NOT 50
  });

  test("the late channel does NOT inherit the early run-up (the actual regression)", () => {
    const late = rollupChannels([pick()], spy, 550).find(c => c.channel === "Late")!;
    expect(late.avgReturnPct).toBeLessThan(50);
  });

  test("alpha uses each channel's OWN window on the SPY leg too", () => {
    const rows = rollupChannels([pick()], spy, 550);
    const early = rows.find(c => c.channel === "Early")!;
    const late = rows.find(c => c.channel === "Late")!;
    // Early: 50% − (550/500−1)=10% → 40%.  Late: 7.14% − (550/540−1)=1.85% → 5.29%
    expect(early.avgAlphaPct!).toBeCloseTo(40, 4);
    expect(late.avgAlphaPct!).toBeCloseTo(5.291, 2);
  });

  test("a pre-fix row with NO channelEntries falls back to the ticker baseline and is flagged inherited", () => {
    const rows = rollupChannels([pick({ channelEntries: undefined })], spy, 550);
    for (const r of rows) {
      expect(r.avgReturnPct).toBeCloseTo(50, 5); // old union number — the only thing stored
      expect(r.inheritedPicks).toBe(r.picks);    // and it says so
    }
  });

  test("a migrated entry marked inherited is counted as inherited, not as fixed", () => {
    const rows = rollupChannels([pick({
      channelEntries: {
        Early: { firstSeenDate: "2026-09-01", priceAtSignal: 100, inherited: true },
        Late: { firstSeenDate: "2026-09-25", priceAtSignal: 140 },
      },
    })], spy, 550);
    expect(rows.find(c => c.channel === "Early")!.inheritedPicks).toBe(1);
    expect(rows.find(c => c.channel === "Late")!.inheritedPicks).toBe(0);
  });

  test("hit rate is computed per channel on its own baseline — a late entry can MISS a winning ticker", () => {
    // Ticker is +50% overall, but the late channel entered above the current price.
    const rows = rollupChannels([pick({
      currentPrice: 130,
      channelEntries: {
        Early: { firstSeenDate: "2026-09-01", priceAtSignal: 100 },
        Late: { firstSeenDate: "2026-09-25", priceAtSignal: 140 },
      },
    })], spy, 550);
    expect(rows.find(c => c.channel === "Early")!.hitRatePct).toBe(100);
    expect(rows.find(c => c.channel === "Late")!.hitRatePct).toBe(0);
  });

  test("alpha is null (not zero) when the channel's own entry date has no SPY baseline", () => {
    const rows = rollupChannels([pick({
      channelEntries: { Late: { firstSeenDate: "2026-09-25", priceAtSignal: 140 } },
      channels: ["Late"],
    })], new Map([["2026-09-01", 500]]), 550);
    expect(rows[0].avgAlphaPct).toBeNull();
  });

  test("an unpriced pick contributes to no channel at all", () => {
    expect(rollupChannels([pick({ currentPrice: null })], spy, 550)).toEqual([]);
  });

  test("a zero/negative baseline is skipped rather than producing Infinity", () => {
    const rows = rollupChannels([pick({
      channels: ["Bad"],
      channelEntries: { Bad: { firstSeenDate: "2026-09-01", priceAtSignal: 0 } },
    })], spy, 550);
    expect(rows).toEqual([]);
  });

  test("channels are ranked by alpha, so the inflated-looking raw return doesn't set the order", () => {
    const rows = rollupChannels([pick()], spy, 550);
    expect(rows[0].channel).toBe("Early");
    expect(rows[0].avgAlphaPct!).toBeGreaterThan(rows[1].avgAlphaPct!);
  });
});

// The migration decides which stored history is trustworthy. Over-flagging permanently mislabels
// correctly-measured picks; under-flagging hides real union credit. Both directions are tested.
describe("migratedChannelEntries — which pre-fix credit is trustworthy", () => {
  function row(over: Partial<LedgerPick> = {}): LedgerPick {
    return {
      ticker: "NVDA",
      channels: ["A", "B"],
      maxScore: 4,
      maxConfidence: "high",
      firstSeenDate: "2026-09-01",
      lastSeenDate: "2026-09-01",
      priceAtSignal: 100,
      ...over,
    };
  }

  test("a row NEVER re-touched cannot have gained a late channel, so nothing is flagged", () => {
    const out = migratedChannelEntries(row({ firstSeenDate: "2026-09-01", lastSeenDate: "2026-09-01" }));
    expect(out.A.inherited).toBeUndefined();
    expect(out.B.inherited).toBeUndefined();
  });

  test("a single-channel row logged once is NOT reported as inherited (the over-flagging bug)", () => {
    const out = migratedChannelEntries(row({ channels: ["Solo"], lastSeenDate: "2026-09-01" }));
    const stats = rollupChannels(
      [{ ...row({ channels: ["Solo"], lastSeenDate: "2026-09-01" }), channelEntries: out,
         currentPrice: 150, returnPct: 50, marketReturnPct: 10, alphaPct: 40, daysElapsed: 30 }],
      new Map([["2026-09-01", 500]]), 550);
    expect(stats[0].inheritedPicks).toBe(0);
    expect(stats[0].picks).toBe(1);
  });

  test("a RE-TOUCHED row flags every channel — we cannot tell which were late", () => {
    const out = migratedChannelEntries(row({ firstSeenDate: "2026-09-01", lastSeenDate: "2026-09-25" }));
    expect(out.A.inherited).toBe(true);
    expect(out.B.inherited).toBe(true);
  });

  test("migration preserves the stored baseline exactly — it never invents a price", () => {
    const out = migratedChannelEntries(row({ priceAtSignal: 123.45, lastSeenDate: "2026-09-25" }));
    expect(out.A.priceAtSignal).toBe(123.45);
    expect(out.A.firstSeenDate).toBe("2026-09-01");
  });
});

describe("rollupChannels — alpha coverage", () => {
  test("alphaPicks reports how many credits actually have a SPY baseline", () => {
    const base = {
      maxScore: 4, maxConfidence: "high" as const, lastSeenDate: "2026-10-01",
      currentPrice: 150, returnPct: 50, marketReturnPct: null, alphaPct: null, daysElapsed: 30,
    };
    const rows = rollupChannels([
      { ...base, ticker: "AAA", channels: ["Ch"], firstSeenDate: "2026-09-01", priceAtSignal: 100,
        channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100 } } },
      { ...base, ticker: "BBB", channels: ["Ch"], firstSeenDate: "2026-09-10", priceAtSignal: 100,
        channelEntries: { Ch: { firstSeenDate: "2026-09-10", priceAtSignal: 100 } } },
    ], new Map([["2026-09-01", 500]]), 550); // only AAA's date has a SPY mark
    expect(rows[0].picks).toBe(2);
    expect(rows[0].alphaPicks).toBe(1); // ranked on half its credits — now visible
  });
});

// The email now lists each channel's actual picks, because the aggregates alone were unauditable:
// a channel's "27 picks" turned out to be one watchlist video naming 17 tickers at once.
describe("rollupChannels — per-channel constituents", () => {
  const base = {
    maxScore: 4, maxConfidence: "high" as const, lastSeenDate: "2026-10-01",
    marketReturnPct: null, alphaPct: null, daysElapsed: 30,
  };
  const row = (ticker: string, cur: number) => ({
    ...base, ticker, channels: ["Ch"], firstSeenDate: "2026-09-01", priceAtSignal: 100,
    currentPrice: cur, returnPct: cur - 100,
    channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100 } },
  });

  test("lists every credited pick with its own return", () => {
    const [c] = rollupChannels([row("AAA", 150), row("BBB", 90)], new Map(), null);
    expect(c.tickerReturns.map(t => t.ticker)).toEqual(["AAA", "BBB"]);
    expect(c.tickerReturns[0].retPct).toBeCloseTo(50, 6);
    expect(c.tickerReturns[1].retPct).toBeCloseTo(-10, 6);
  });

  test("sorted best-first, so the email leads with the winners", () => {
    const [c] = rollupChannels([row("LOSS", 80), row("WIN", 200), row("MID", 110)], new Map(), null);
    expect(c.tickerReturns.map(t => t.ticker)).toEqual(["WIN", "MID", "LOSS"]);
  });

  test("the constituent count matches the headline pick count — no silent drops", () => {
    const [c] = rollupChannels([row("AAA", 150), row("BBB", 90), row("CCC", 101)], new Map(), null);
    expect(c.tickerReturns.length).toBe(c.picks);
  });

  test("an unpriced pick is absent from BOTH the count and the list", () => {
    const [c] = rollupChannels([row("AAA", 150), { ...row("BBB", 0), currentPrice: null }], new Map(), null);
    expect(c.picks).toBe(1);
    expect(c.tickerReturns.map(t => t.ticker)).toEqual(["AAA"]);
  });
});

// A channel that recommends a name and LATER says avoid used to keep an open credit forever — so it
// was charged with the crash it warned about, while an avoid before a rally earned the rally. The
// bias ran against exactly the behaviour worth rewarding.
describe("rollupChannels — a credit closed by the channel's own AVOID", () => {
  const spy = new Map([["2026-09-01", 500], ["2026-09-20", 520], ["2026-10-01", 560]]);
  const mk = (over: Partial<PickOutcome> = {}): PickOutcome => ({
    ticker: "AAA", channels: ["Ch"], maxScore: 4, maxConfidence: "high",
    firstSeenDate: "2026-09-01", lastSeenDate: "2026-10-01", priceAtSignal: 100,
    currentPrice: 60, returnPct: -40, marketReturnPct: null, alphaPct: null, daysElapsed: 30,
    channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100 } },
    ...over,
  });

  test("the return stops at the close — the channel is not charged with the later crash", () => {
    const closed = mk({ channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100, closedDate: "2026-09-20", closePrice: 130 } } });
    const [c] = rollupChannels([closed], spy, 560);
    expect(c.avgReturnPct).toBeCloseTo(30, 6);   // 100 -> 130 at the avoid, NOT 100 -> 60
    expect(c.closedPicks).toBe(1);
    expect(c.hitRatePct).toBe(100);
  });

  test("alpha uses the SPY mark at the CLOSE, not today's — both legs share the window", () => {
    const closed = mk({ channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100, closedDate: "2026-09-20", closePrice: 130 } } });
    const [c] = rollupChannels([closed], spy, 560);
    // 30% − (520/500−1 = 4%) = 26%.  Using spyNow=560 would give 30 − 12 = 18%.
    expect(c.avgAlphaPct!).toBeCloseTo(26, 4);
  });

  test("an OPEN credit still marks to today", () => {
    const [c] = rollupChannels([mk()], spy, 560);
    expect(c.avgReturnPct).toBeCloseTo(-40, 6);
    expect(c.closedPicks).toBe(0);
  });

  test("a closed pick is flagged in the constituent list", () => {
    const closed = mk({ channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100, closedDate: "2026-09-20", closePrice: 130 } } });
    const [c] = rollupChannels([closed], spy, 560);
    expect(c.tickerReturns[0].closed).toBe(true);
  });

  test("a zero/negative close price is ignored rather than zeroing the return", () => {
    const bad = mk({ channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100, closedDate: "2026-09-20", closePrice: 0 } } });
    const [c] = rollupChannels([bad], spy, 560);
    expect(c.avgReturnPct).toBeCloseTo(-40, 6); // falls back to the live mark
    expect(c.closedPicks).toBe(0);
  });

  test("closing one channel does not close another's credit on the same ticker", () => {
    const two = mk({
      channels: ["Early", "Late"],
      channelEntries: {
        Early: { firstSeenDate: "2026-09-01", priceAtSignal: 100, closedDate: "2026-09-20", closePrice: 130 },
        Late: { firstSeenDate: "2026-09-01", priceAtSignal: 100 },
      },
    });
    const rows = rollupChannels([two], spy, 560);
    expect(rows.find(r => r.channel === "Early")!.avgReturnPct).toBeCloseTo(30, 6);
    expect(rows.find(r => r.channel === "Late")!.avgReturnPct).toBeCloseTo(-40, 6);
  });
});

// EARLIEST WINS: a credit ends at the channel's own avoid or at HORIZON_DAYS, whichever is first.
// Without a horizon every return ran first-sighting → now, so "hit" meant "green at this instant".
describe("rollupChannels — 30-day horizon, earliest-wins", () => {
  const d = (iso: string) => Math.floor(Date.parse(`${iso}T13:30:00Z`) / 1000);
  // Daily bars spanning 2026-09-01 .. 2026-10-10, price rising then collapsing after day 30.
  const bars: DatedBars = {
    ts: ["2026-09-01","2026-09-15","2026-10-01","2026-10-05","2026-10-10"].map(d),
    closes: [100, 120, 130, 60, 50],
  };
  const spy = new Map([["2026-09-01", 500], ["2026-09-15", 510], ["2026-10-01", 520], ["2026-10-10", 560]]);
  const barsByTicker = new Map([["AAA", bars]]);
  const mk = (over: Partial<PickOutcome> = {}): PickOutcome => ({
    ticker: "AAA", channels: ["Ch"], maxScore: 4, maxConfidence: "high",
    firstSeenDate: "2026-09-01", lastSeenDate: "2026-10-01", priceAtSignal: 100,
    currentPrice: 50, returnPct: -50, marketReturnPct: null, alphaPct: null, daysElapsed: 39,
    channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100 } },
    ...over,
  });

  test("closes at day 30, so the later collapse is NOT charged to the channel", () => {
    const [c] = rollupChannels([mk()], spy, 560, barsByTicker);
    expect(c.avgReturnPct).toBeCloseTo(30, 6);  // 100 -> 130 at 2026-10-01, not -> 50
    expect(c.medianHoldDays).toBe(30);
  });

  test("an AVOID before day 30 wins — the channel's own exit beats the horizon", () => {
    const early = mk({ channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100, closedDate: "2026-09-15", closePrice: 120 } } });
    const [c] = rollupChannels([early], spy, 560, barsByTicker);
    expect(c.avgReturnPct).toBeCloseTo(20, 6);  // 100 -> 120 at the avoid
    expect(c.closedPicks).toBe(1);
    expect(c.medianHoldDays).toBe(14);
  });

  test("an AVOID after day 30 is irrelevant — the horizon already closed it", () => {
    const late = mk({ channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100, closedDate: "2026-10-05", closePrice: 60 } } });
    const [c] = rollupChannels([late], spy, 560, barsByTicker);
    expect(c.avgReturnPct).toBeCloseTo(30, 6);
    expect(c.closedPicks).toBe(0); // closed by the horizon, not by the avoid
  });

  test("alpha uses SPY at the SAME end date as the pick", () => {
    const [c] = rollupChannels([mk()], spy, 560, barsByTicker);
    // 30% − (520/500−1 = 4%) = 26%. Marking SPY to 560 would give 30 − 12 = 18%.
    expect(c.avgAlphaPct!).toBeCloseTo(26, 4);
  });

  test("an IMMATURE pick is pending — excluded from every stat, and counted", () => {
    const fresh = mk({
      firstSeenDate: "2026-10-10", priceAtSignal: 50,
      channelEntries: { Ch: { firstSeenDate: "2026-10-10", priceAtSignal: 50 } },
    });
    const rows = rollupChannels([fresh], spy, 560, barsByTicker);
    // Only pending picks → the channel has nothing measurable to report.
    expect(rows).toEqual([]);
  });

  test("pending picks are counted alongside measured ones", () => {
    const fresh = { ...mk({ ticker: "BBB" }), firstSeenDate: "2026-10-10", priceAtSignal: 50,
      channelEntries: { Ch: { firstSeenDate: "2026-10-10", priceAtSignal: 50 } } };
    const rows = rollupChannels([mk(), fresh], spy, 560, new Map([["AAA", bars], ["BBB", bars]]));
    const c = rows.find(r => r.channel === "Ch")!;
    expect(c.picks).toBe(1);
    expect(c.pendingPicks).toBe(1);
  });

  test("without bars it degrades to the open-ended measure rather than marking all pending", () => {
    const [c] = rollupChannels([mk()], spy, 560);
    expect(c.avgReturnPct).toBeCloseTo(-50, 6);
    expect(c.pendingPicks).toBe(0);
  });
});

// σ is ~14-15% per 30-day pick and the picks are correlated (mostly AI/semis), so "alpha vs SPY"
// still carries a large common factor — which is why the CI floors at ±1.96σ√ρ no matter how many
// simultaneous picks accrue. These two measures remove that common factor.
describe("rollupChannels — sector-relative and peer-relative edge", () => {
  const d = (iso: string) => Math.floor(Date.parse(`${iso}T13:30:00Z`) / 1000);
  const dates = ["2026-09-01", "2026-10-01"];
  const mkBars = (closes: number[]): DatedBars => ({ ts: dates.map(d), closes });
  const spy = new Map([["2026-09-01", 500], ["2026-10-01", 520]]);   // SPY +4%
  // AAPL is XLK in STOCK_SECTOR. Stock +30%, sector +20% → sector-relative +10%.
  const barsByTicker = new Map([["AAPL", mkBars([100, 130])]]);
  const sectorBars = new Map([["XLK", mkBars([200, 240])]]);
  const pick = (ticker: string, ch: string, closes: number[]) => ({
    ticker, channels: [ch], maxScore: 4, maxConfidence: "high" as const,
    firstSeenDate: "2026-09-01", lastSeenDate: "2026-10-01", priceAtSignal: closes[0],
    currentPrice: closes[1], returnPct: 0, marketReturnPct: null, alphaPct: null, daysElapsed: 30,
    channelEntries: { [ch]: { firstSeenDate: "2026-09-01", priceAtSignal: closes[0] } },
  });

  test("sector-relative strips the sector move, leaving a smaller honest edge", () => {
    const [c] = rollupChannels([pick("AAPL", "Ch", [100, 130])], spy, 520, barsByTicker, sectorBars);
    expect(c.avgReturnPct).toBeCloseTo(30, 4);
    expect(c.avgAlphaPct!).toBeCloseTo(26, 4);        // vs SPY  (+4%)
    expect(c.avgSectorAlphaPct!).toBeCloseTo(10, 4);  // vs XLK  (+20%) — the real edge
    expect(c.sectorPicks).toBe(1);
  });

  test("a pick with no sector mapping yields null, not zero", () => {
    // BTC is not in STOCK_SECTOR; zero would read as "no edge" rather than "not measured".
    const bars = new Map([["BTC", mkBars([100, 130])]]);
    const [c] = rollupChannels([pick("BTC", "Ch", [100, 130])], spy, 520, bars, sectorBars);
    expect(c.avgSectorAlphaPct).toBeNull();
    expect(c.sectorPicks).toBe(0);
  });

  test("peer-relative compares against OVERLAPPING picks, so a shared wave cancels", () => {
    const bars = new Map([["AAPL", mkBars([100, 130])], ["MSFT", mkBars([100, 110])]]);
    const rows = rollupChannels(
      [pick("AAPL", "Good", [100, 130]), pick("MSFT", "Bad", [100, 110])],
      spy, 520, bars, sectorBars,
    );
    // Both +30% and +10%; each is measured against the other.
    expect(rows.find(r => r.channel === "Good")!.avgPeerRelPct!).toBeCloseTo(20, 4);
    expect(rows.find(r => r.channel === "Bad")!.avgPeerRelPct!).toBeCloseTo(-20, 4);
  });

  test("a lone pick has no peers, so peer-relative is null rather than a flattering 0", () => {
    const [c] = rollupChannels([pick("AAPL", "Ch", [100, 130])], spy, 520, barsByTicker, sectorBars);
    expect(c.avgPeerRelPct).toBeNull();
  });

  test("channels are ranked by SECTOR-relative edge, not by raw return", () => {
    // RAW favours AAPL(+30%); SECTOR-relative favours MSFT, whose sector went nowhere.
    const bars = new Map([["AAPL", mkBars([100, 130])], ["XOM", mkBars([100, 115])]]);
    const sectors = new Map([["XLK", mkBars([200, 260])], ["XLE", mkBars([50, 50])]]);  // XLK +30%, XLE flat
    const rows = rollupChannels(
      [pick("AAPL", "Hype", [100, 130]), pick("XOM", "Real", [100, 115])],
      spy, 520, bars, sectors,
    );
    expect(rows[0].channel).toBe("Real");          // +15% vs a flat sector
    expect(rows[0].avgSectorAlphaPct!).toBeCloseTo(15, 4);
    expect(rows[1].avgSectorAlphaPct!).toBeCloseTo(0, 4);  // +30% in a +30% sector = no edge
  });
});

// The overlap filter is the whole point of "contemporaneous" — without it, peer-relative compares
// across regimes, which is the factor it exists to remove. Fixtures that share one window cannot
// tell the two apart, so these use DISJOINT windows.
describe("rollupChannels — peer-relative requires an overlapping window", () => {
  const d = (iso: string) => Math.floor(Date.parse(`${iso}T13:30:00Z`) / 1000);
  const spy = new Map([["2026-01-01", 400], ["2026-02-02", 410], ["2026-09-01", 500], ["2026-10-01", 520]]);
  const autumn: DatedBars = { ts: ["2026-09-01", "2026-10-01"].map(d), closes: [100, 130] };
  const winter: DatedBars = { ts: ["2026-01-01", "2026-02-02"].map(d), closes: [100, 110] };
  const mk = (ticker: string, ch: string, start: string, px: number) => ({
    ticker, channels: [ch], maxScore: 4, maxConfidence: "high" as const,
    firstSeenDate: start, lastSeenDate: start, priceAtSignal: px,
    currentPrice: px, returnPct: 0, marketReturnPct: null, alphaPct: null, daysElapsed: 30,
    channelEntries: { [ch]: { firstSeenDate: start, priceAtSignal: px } },
  });

  test("picks in non-overlapping windows are NOT peers of each other", () => {
    const rows = rollupChannels(
      [mk("AAPL", "Autumn", "2026-09-01", 100), mk("MSFT", "Winter", "2026-01-01", 100)],
      spy, 520,
      new Map([["AAPL", autumn], ["MSFT", winter]]),
      new Map(),
    );
    // Each is alone in its own window, so neither has a peer to be measured against.
    for (const r of rows) expect(r.avgPeerRelPct).toBeNull();
  });

  test("picks that DO overlap are peers", () => {
    const rows = rollupChannels(
      [mk("AAPL", "A", "2026-09-01", 100), mk("MSFT", "B", "2026-09-01", 100)],
      spy, 520,
      new Map([["AAPL", autumn], ["MSFT", { ts: autumn.ts, closes: [100, 110] }]]),
      new Map(),
    );
    expect(rows.find(r => r.channel === "A")!.avgPeerRelPct).not.toBeNull();
  });
});

// Cohorts must NEVER be pooled: required n scales with (sigma/effect)^2, so mixing low-conviction
// mentions into one average halves the effect while leaving the noise — pushing required n UP ~4x
// while looking like more data.
describe("rollupChannels — score cohorts", () => {
  const d = (iso: string) => Math.floor(Date.parse(`${iso}T13:30:00Z`) / 1000);
  const bars: DatedBars = { ts: ["2026-09-01", "2026-10-01"].map(d), closes: [100, 130] };
  const spy = new Map([["2026-09-01", 500], ["2026-10-01", 520]]);
  const mk = (ticker: string, score: number | undefined, px: number) => ({
    ticker, channels: ["Ch"], maxScore: 4, maxConfidence: "high" as const,
    firstSeenDate: "2026-09-01", lastSeenDate: "2026-10-01", priceAtSignal: 100,
    currentPrice: px, returnPct: 0, marketReturnPct: null, alphaPct: null, daysElapsed: 30,
    channelEntries: { Ch: { firstSeenDate: "2026-09-01", priceAtSignal: 100, ...(score != null ? { scoreAtEntry: score } : {}) } },
  });
  const barsFor = (t: string, closes: number[]): [string, DatedBars] => [t, { ts: bars.ts, closes }];

  test("the buy-floor cohort excludes sub-floor credits", () => {
    const b = new Map([barsFor("HI", [100, 130]), barsFor("LO", [100, 50])]);
    const [c] = rollupChannels([mk("HI", 4, 130), mk("LO", 1, 50)], spy, 520, b, new Map(), sc => sc >= 3);
    expect(c.picks).toBe(1);
    expect(c.avgReturnPct).toBeCloseTo(30, 4);   // the −50% sub-floor pick must not drag it
  });

  test("the sub-floor cohort is its own population", () => {
    const b = new Map([barsFor("HI", [100, 130]), barsFor("LO", [100, 50])]);
    const [c] = rollupChannels([mk("HI", 4, 130), mk("LO", 1, 50)], spy, 520, b, new Map(), sc => sc < 3);
    expect(c.picks).toBe(1);
    expect(c.avgReturnPct).toBeCloseTo(-50, 4);
  });

  test("pooling the two would be a DIFFERENT, misleading number", () => {
    const b = new Map([barsFor("HI", [100, 130]), barsFor("LO", [100, 50])]);
    const [pooled] = rollupChannels([mk("HI", 4, 130), mk("LO", 1, 50)], spy, 520, b, new Map());
    expect(pooled.avgReturnPct).toBeCloseTo(-10, 4);  // neither cohort's truth
  });

  test("a credit with NO scoreAtEntry counts as buy-floor — nothing below it was tracked then", () => {
    const b = new Map([barsFor("OLD", [100, 130])]);
    const atFloor = rollupChannels([mk("OLD", undefined, 130)], spy, 520, b, new Map(), sc => sc >= 3);
    const below = rollupChannels([mk("OLD", undefined, 130)], spy, 520, b, new Map(), sc => sc < 3);
    expect(atFloor[0].picks).toBe(1);
    expect(below).toEqual([]);
  });
});
