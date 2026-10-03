import { describe, expect, test } from "bun:test";
import { rollupChannels, migratedChannelEntries, type PickOutcome, type LedgerPick } from "../lib/influencer-ledger";

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
