import { describe, expect, test } from "bun:test";
import { rollupTriggers, triggerFromReason, type ExitOutcome, type ExitTrigger } from "../lib/exit-ledger";

// The mirror of the signal ledger. That one measures which signals pick good ENTRIES; nothing
// measured whether our EXITS beat holding — and exits are a large share of what the agent does
// (⚡NEWS↓, ↓FIRM, the time-stop, drop-check stops, shortlist rotations). The registry records
// exits that cost money and were caught one at a time by hand (ILMN sold 08-06 @ $188.96,
// re-bought 08-07 @ $188.54), which is the situation a ledger exists to end.
const mk = (over: Partial<ExitOutcome> = {}): ExitOutcome => ({
  symbol: "AAA", date: "2026-10-01", strategy: "main", priceAtExit: 100,
  trigger: "news-down", currentPrice: 90, returnPct: -10, daysElapsed: 7, ...over,
});

describe("rollupTriggers", () => {
  test("NEGATIVE post-exit return is a GOOD exit — the sign is inverted vs the buy ledger", () => {
    // The single easiest thing to get backwards in this file. A good exit is one the price fell
    // after; reading these like buy-side returns inverts every conclusion the ledger supports.
    const [t] = rollupTriggers([mk({ returnPct: -12 }), mk({ symbol: "BBB", returnPct: -8 })]);
    expect(t.avgReturnPct).toBeCloseTo(-10, 6);
    expect(t.avoidedRatePct).toBe(100);        // both fell after we left
  });

  test("avoidedRate counts only the exits the price fell after", () => {
    const [t] = rollupTriggers([
      mk({ returnPct: -10 }), mk({ symbol: "B", returnPct: +20 }),
      mk({ symbol: "C", returnPct: -5 }), mk({ symbol: "D", returnPct: +1 }),
    ]);
    expect(t.exits).toBe(4);
    expect(t.avoidedRatePct).toBe(50);
    expect(t.bestExit).toBe("AAA -10.0%");     // best = fell the most after
    expect(t.worstExit).toBe("B +20.0%");      // worst = ran away from us
  });

  test("triggers are ranked by edge — the one whose names fell hardest comes first", () => {
    const rows = rollupTriggers([
      mk({ trigger: "stale", returnPct: +15 }),
      mk({ trigger: "news-down", returnPct: -20 }),
      mk({ trigger: "stop", returnPct: -2 }),
    ]);
    expect(rows.map(r => r.trigger)).toEqual(["news-down", "stop", "stale"]);
  });

  test("triggers are never pooled — each is its own question", () => {
    const rows = rollupTriggers([mk({ trigger: "news-down" }), mk({ trigger: "stale", returnPct: +5 })]);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.exits)).toEqual([1, 1]);
  });

  test("an unpriceable exit contributes to NOTHING", () => {
    // It must not quietly count as a 0% move, which would drag every average toward zero.
    const [t] = rollupTriggers([mk({ returnPct: -10 }), mk({ symbol: "B", currentPrice: null, returnPct: null })]);
    expect(t.exits).toBe(1);
    expect(t.avgReturnPct).toBeCloseTo(-10, 6);
  });

  test("CONTROL — no exits, no rows", () => {
    expect(rollupTriggers([])).toEqual([]);
  });
});

describe("triggerFromReason", () => {
  test("every documented reason maps to itself", () => {
    for (const r of ["news-down", "firm-down", "stale", "shortlist-drop", "concentration", "stop", "take-profit", "earnings"] as ExitTrigger[]) {
      expect(triggerFromReason(r)).toBe(r);
    }
  });

  test("an unknown or missing reason degrades to discretionary, NEVER to a real trigger", () => {
    // Guessing would inflate whichever trigger the default pointed at and corrupt the measurement
    // for every honest exit of that kind — the one failure this ledger cannot survive.
    for (const bad of [undefined, "", "   ", "because-i-felt-like-it", "NEWS", "sell"]) {
      expect(triggerFromReason(bad)).toBe("discretionary");
    }
  });

  test("case and whitespace are tolerated — the model's token, not its formatting", () => {
    expect(triggerFromReason("  News-Down ")).toBe("news-down");
  });
});

// ── the drop-check live-state guard ──────────────────────────────────────────
// Extracted verbatim from app/api/drop-check/route.ts. The adjustment block is the dangerous half
// of that change — it decides whether a real stop-loss order is placed, skipped or re-sized — and
// /api/drop-check with no scope (the only MAIN-book check) runs ONCE a day, so a wrongly skipped
// stop has no second chance until tomorrow.
type Live = { positions: Array<{ symbol: string; quantity: string }>; sellIds: Set<string>; sawIds: boolean } | null;

/** The parser's accept/reject rule, as shipped. */
function parseLive(positions: any, priorSellsRaw: any): Live {
  if (!positions || positions.length === 0 || priorSellsRaw === null) return null;
  const bad = positions.find((p: any) => !/^[A-Z][A-Z.]{0,5}$/.test(String(p?.symbol ?? "").trim().toUpperCase())
                                      || !(parseFloat(String(p?.quantity ?? "")) > 0));
  if (bad) return null;
  return {
    positions: positions.map((p: any) => ({ symbol: String(p.symbol).trim().toUpperCase(), quantity: String(p.quantity) })),
    sellIds: new Set((priorSellsRaw as any[]).map(o => String(o.id ?? "")).filter(Boolean)),
    sawIds: priorSellsRaw.length === 0 || (priorSellsRaw as any[]).some(o => o.id),
  };
}

/** The adjustment block, as shipped. Returns what would actually be sent to the broker. */
function adjust(sells: Array<{ symbol: string; quantity: string }>, held: Array<{ symbol: string }>, pre: Live) {
  const out = sells.map(s => ({ ...s })); const notes: string[] = [];
  if (pre) {
    const liveQty = new Map(pre.positions.map(p => [p.symbol, parseFloat(p.quantity) || 0]));
    const exiting = new Set(out.map(s => s.symbol));
    const corroborated = held.some(p => !exiting.has(p.symbol) && (liveQty.get(p.symbol) ?? 0) > 0);
    if (!corroborated && held.some(p => !exiting.has(p.symbol))) {
      notes.push("uncorroborated");
    } else {
      for (let i = out.length - 1; i >= 0; i--) {
        const live = liveQty.get(out[i].symbol) ?? 0;
        const want = parseFloat(out[i].quantity) || 0;
        if (live <= 0) { notes.push(`${out[i].symbol} (no longer held)`); out.splice(i, 1); continue; }
        if (live < want * 0.995) { notes.push(`${out[i].symbol} (owner trimmed to ${live})`); out[i] = { ...out[i], quantity: String(live) }; }
      }
    }
  } else if (out.length > 0) notes.push("unreadable");
  return { sells: out, notes };
}

describe("drop-check: a degraded live read must NOT cancel a stop-loss", () => {
  const held = [{ symbol: "ILMN" }, { symbol: "APA" }];
  const sells = [{ symbol: "ILMN", quantity: "1.5" }];

  test("the template echo is rejected — the placeholders are VALID JSON", () => {
    // "XX"/"X.XX" are already quoted strings, so a verbatim echo parses cleanly. The trade route
    // hit exactly this class and guards against it; this read must too, or every stop is skipped.
    expect(parseLive([{ symbol: "XX", quantity: "X.XX" }], [])).toBeNull();
  });

  test("an EMPTY position list is unusable, not 'the account is flat'", () => {
    // The reader is told "if empty output []", which is also what it says when the MCP tool errors.
    expect(parseLive([], [])).toBeNull();
  });

  test("a malformed row rejects the WHOLE read", () => {
    for (const bad of [[{ symbol: "ILMN", qty: "1.5" }], [{ symbol: "ILMN", quantity: "0" }], [{ symbol: "", quantity: "1" }]]) {
      expect(parseLive(bad, [])).toBeNull();
    }
  });

  test("unreadable prior-sells is unusable too — absent is not 'none'", () => {
    expect(parseLive([{ symbol: "ILMN", quantity: "1.5" }], null)).toBeNull();
  });

  test("a null read PLACES the exit on the snapshot — a risk path fails toward selling", () => {
    const r = adjust(sells, held, null);
    expect(r.sells.map(s => s.symbol)).toEqual(["ILMN"]);   // the stop still goes out
    expect(r.notes).toEqual(["unreadable"]);
  });

  test("a read that corroborates nothing may NOT veto — it places and says so", () => {
    // Well-formed but about another account, or badly truncated: no held non-exiting name appears.
    const pre = parseLive([{ symbol: "ZZZZ", quantity: "9" }], []);
    const r = adjust(sells, held, pre);
    expect(r.sells.map(s => s.symbol)).toEqual(["ILMN"]);
    expect(r.notes).toEqual(["uncorroborated"]);
  });

  test("a CORROBORATED read may veto — the real 2026-10-06 ILMN case", () => {
    // APA is held, not exiting, and present live → the read describes this account. ILMN is absent
    // from it because the owner already sold, so the order is correctly dropped.
    const pre = parseLive([{ symbol: "APA", quantity: "6" }], []);
    const r = adjust(sells, held, pre);
    expect(r.sells).toEqual([]);
    expect(r.notes).toEqual(["ILMN (no longer held)"]);
  });

  test("2dp rounding does NOT re-size — no dangling fraction, no false 'owner trimmed'", () => {
    // The reader formats to ~2dp, so a held 2.371 comes back "2.37". Re-sizing on that strands
    // 0.001 shares and blames the owner for a trim they never made.
    const pre = parseLive([{ symbol: "APA", quantity: "6" }, { symbol: "NVDA", quantity: "2.37" }], []);
    const r = adjust([{ symbol: "NVDA", quantity: "2.371" }], [{ symbol: "APA" }, { symbol: "NVDA" }], pre);
    expect(r.sells).toEqual([{ symbol: "NVDA", quantity: "2.371" }]);
    expect(r.notes).toEqual([]);
  });

  test("a REAL partial sale still re-sizes", () => {
    const pre = parseLive([{ symbol: "APA", quantity: "6" }, { symbol: "NVDA", quantity: "1" }], []);
    const r = adjust([{ symbol: "NVDA", quantity: "2.371" }], [{ symbol: "APA" }, { symbol: "NVDA" }], pre);
    expect(r.sells).toEqual([{ symbol: "NVDA", quantity: "1" }]);
    expect(r.notes).toEqual(["NVDA (owner trimmed to 1)"]);
  });

  test("CONTROL — a clean read leaves a normal exit untouched", () => {
    const pre = parseLive([{ symbol: "APA", quantity: "6" }, { symbol: "ILMN", quantity: "1.5" }], []);
    expect(adjust(sells, held, pre)).toEqual({ sells: [{ symbol: "ILMN", quantity: "1.5" }], notes: [] });
  });
});

describe("drop-check: whose fill was it", () => {
  const isOurs = (pre: Live, v: { id?: string }) => !pre || !pre.sawIds || !v.id || !pre.sellIds.has(v.id);

  test("an order placed BEFORE ours is not ours", () => {
    const pre = parseLive([{ symbol: "APA", quantity: "6" }], [{ id: "owner-1", symbol: "CRM", quantity: "3.2" }]);
    expect(isOurs(pre, { id: "owner-1" })).toBe(false);
    expect(isOurs(pre, { id: "ours-9" })).toBe(true);
  });

  test("SAME quantity, different order — ours is NOT discarded", () => {
    // Both the agent and the owner exit a whole position, so quantities collide. Keying on quantity
    // threw away the agent's own fill, which then read as "did not fill" and triggered a retry —
    // a second real sell order.
    const pre = parseLive([{ symbol: "APA", quantity: "6" }], [{ id: "owner-1", symbol: "CRM", quantity: "3.2" }]);
    expect(isOurs(pre, { id: "ours-2" })).toBe(true);
  });

  test("no ids available → treat as OURS, never discard a genuine fill", () => {
    // Discarding is the worse error: the sale goes unrecorded while its proceeds sit in cash, so
    // portfolioAfter double-counts the position and the day's return inflates.
    const noIds = parseLive([{ symbol: "APA", quantity: "6" }], [{ symbol: "CRM", quantity: "3.2" }]);
    expect(noIds!.sawIds).toBe(false);
    expect(isOurs(noIds, { id: "ours-2" })).toBe(true);
    expect(isOurs(null, { id: "whatever" })).toBe(true);
  });
});

// ── storage contract ─────────────────────────────────────────────────────────
import { dedupeExits, recordExits, type ExitRecord } from "../lib/exit-ledger";

describe("dedupeExits", () => {
  const e = (symbol: string, trigger: ExitTrigger, date = "2026-10-08"): ExitRecord =>
    ({ symbol, date, strategy: "main", priceAtExit: 100, trigger });

  test("the same name can exit TWICE in a day under different triggers", () => {
    // 07:30 trims MU on the sector cap; 10:00 drop-check stops out the remainder. Keying on
    // date|symbol kept only the first, and since write order is fixed that biased the ledger
    // against stops, take-profits and earnings exits — the numbers it exists to measure.
    const fresh = dedupeExits([e("MU", "concentration")], [e("MU", "stop")]);
    expect(fresh.map(x => x.trigger)).toEqual(["stop"]);
  });

  test("a genuine re-run of the same exit is still deduped", () => {
    expect(dedupeExits([e("MU", "stop")], [e("MU", "stop")])).toEqual([]);
  });

  test("duplicates WITHIN one batch are collapsed", () => {
    expect(dedupeExits([], [e("MU", "stop"), e("MU", "stop")]).length).toBe(1);
  });

  test("an unpriceable exit is never stored", () => {
    expect(dedupeExits([], [{ ...e("MU", "stop"), priceAtExit: 0 }])).toEqual([]);
  });
});

describe("recordExits storage contract", () => {
  test("an unreadable store SKIPS the write — it must never overwrite history with []", () => {
    // read-modify-write on one blob: treating a transient failure as "empty" would wipe a year of
    // exits. lib/signal-ledger states this contract in a comment; the first version of this file
    // copied the shape and not the rule.
    const url = process.env.UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
    return recordExits([{ symbol: "MU", date: "2026-10-08", strategy: "main", priceAtExit: 100, trigger: "stop" }])
      .then((r) => {
        // "read", specifically: the history could not be LOADED, so the append was abandoned rather
        // than overwriting it. A plain boolean could not tell that from a failed write, which is a
        // materially different situation (history intact, one row lost).
        expect(r).toEqual({ recorded: 0, skipped: "read" });
      })
      .finally(() => {
        if (url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
        else process.env.UPSTASH_REDIS_REST_URL = url;
      });
  });
});
