import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { applySleeveTag, type TradeRun } from "@/lib/run-store";

// 2026-10-27: the owner bought AMZN and asked for it in the INFLUENCER sleeve. Owner trades are
// captured with the sleeve the symbol already had, so a new name always landed in main with no way
// to relabel it. applySleeveTag is that way; these pin what it may and may not touch.
const pos = (symbol: string) => ({ symbol, quantity: "1", avgCost: "100", price: "100" });
const run = (): TradeRun => ({
  timestamp: "2026-10-28T14:30:00Z", date: "2026-10-28", summary: "",
  positions: [pos("AMZN"), pos("PLTR"), pos("MU")],
  influencerPositions: [pos("PLTR")],
  trades: [
    { symbol: "AMZN", side: "buy", quantity: "1", avgPrice: "100", state: "filled", actor: "human", strategy: "main" },
    { symbol: "MU", side: "sell", quantity: "1", avgPrice: "100", state: "filled", strategy: "main" },
  ],
} as unknown as TradeRun);

describe("applySleeveTag", () => {
  test("AMZN → influencer: buy retagged and added to the sleeve, which later runs carry forward", () => {
    const r = run(); const out = applySleeveTag(r, "AMZN", "influencer");
    expect(out).toEqual({ buys: 1, membership: "added" });
    expect(r.trades![0].strategy).toBe("influencer");
    expect(r.influencerPositions!.map(p => p.symbol).sort()).toEqual(["AMZN", "PLTR"]);
  });
  test("idempotent, and never touches other symbols or any SELL", () => {
    const r = run(); applySleeveTag(r, "AMZN", "influencer");
    expect(applySleeveTag(r, "AMZN", "influencer")).toEqual({ buys: 0, membership: "unchanged" });
    expect(r.trades![1].strategy).toBe("main");
    const s = run(); s.trades!.push({ symbol: "AMZN", side: "sell", quantity: "1", avgPrice: "1", state: "filled", strategy: "main" } as never);
    applySleeveTag(s, "AMZN", "influencer");
    expect(s.trades!.filter(t => t.side === "sell").every(t => t.strategy === "main")).toBe(true);
  });
  test("a name the run does not hold is not invented into the sleeve", () => {
    const r = run(); r.positions = r.positions!.filter(p => p.symbol !== "AMZN");
    expect(applySleeveTag(r, "AMZN", "influencer").membership).toBe("not-held");
    expect(r.influencerPositions!.map(p => p.symbol)).toEqual(["PLTR"]);
  });
  test("a run that predates sleeve tracking is left alone (no invented one-name sleeve)", () => {
    const r = run(); delete (r as { influencerPositions?: unknown }).influencerPositions;
    expect(applySleeveTag(r, "AMZN", "influencer")).toEqual({ buys: 0, membership: "untracked" });
    expect(r.influencerPositions).toBeUndefined();
    expect(r.trades![0].strategy).toBe("main");
  });
  test("→ main removes it from the sleeve", () => {
    const r = run();
    expect(applySleeveTag(r, "PLTR", "main").membership).toBe("removed");
    expect(r.influencerPositions).toEqual([]);
  });
  test("wiring: the debug route validates input and delegates to tagSleeveFrom", () => {
    const src = readFileSync(`${import.meta.dir}/../app/api/debug/route.ts`, "utf8");
    expect(src).toContain("await tagSleeveFrom(date, symbol, sleeve)");
    expect(src).toContain('sleeve !== "influencer" && sleeve !== "main"');
    expect(src).toContain('(rawSymbol ?? "").toUpperCase()');
    expect(src).toContain("NOT applied — ${res.reason}");
    expect(src).toContain("Run ?recomputeSleeves=1 next.");
  });
});

// tagSleeveFrom against a stubbed Upstash: the refusals are the point (each was a false success in
// an earlier review pass), so they are exercised for real rather than pinned as text.
describe("tagSleeveFrom (stubbed run store)", () => {
  const mk = (date: string, ts: string, held: string[], infl: string[], buys: Array<[string, string]> = []) => ({
    timestamp: `${date}T${ts}:00Z`, date, summary: "",
    positions: held.map(pos), influencerPositions: infl.map(pos),
    trades: buys.map(([symbol, strategy]) => ({ symbol, side: "buy", quantity: "1", avgPrice: "1", state: "filled", strategy })),
  });
  let store: unknown[] = [];
  let saveDuringWrite = false;
  const realFetch = globalThis.fetch;
  const install = () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://stub"; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
    let reads = 0;
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("/lrange/")) {
        reads++;
        if (saveDuringWrite && reads === 2) store = [mk("2026-10-29", "14:30", [], []), ...store];
        return new Response(JSON.stringify({ result: store.map(r => JSON.stringify(r)) }));
      }
      if (u.endsWith("/pipeline")) {
        const cmds = JSON.parse(init!.body!) as string[][];
        if (cmds[0][0] === "DEL") store = cmds.slice(1).map(c => JSON.parse(c[2]));
        return new Response(JSON.stringify([{ result: "OK" }]));
      }
      return new Response(JSON.stringify({ result: null }));
    }) as typeof fetch;
  };
  const envBefore = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  const restore = () => {
    globalThis.fetch = realFetch; saveDuringWrite = false;
    // Other test files share this process and rely on "Upstash not configured" — put it back.
    for (const [k, v] of [["UPSTASH_REDIS_REST_URL", envBefore.url], ["UPSTASH_REDIS_REST_TOKEN", envBefore.token]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  test("tags every run from the first held day through the newest, and the newest carries it", async () => {
    const { tagSleeveFrom } = await import("@/lib/run-store");
    store = [mk("2026-10-29", "14:30", ["AMZN", "PLTR"], ["PLTR"]), mk("2026-10-28", "17:00", ["AMZN", "PLTR"], ["PLTR"]),
      mk("2026-10-28", "14:30", ["AMZN", "PLTR"], ["PLTR"], [["AMZN", "main"]]), mk("2026-10-27", "14:30", ["PLTR"], ["PLTR"])];
    install();
    try {
      const r = await tagSleeveFrom("2026-10-28", "AMZN", "influencer");
      expect(r.ok).toBe(true);
      const runs = store as Array<ReturnType<typeof mk>>;
      for (const run of runs.filter(x => x.date >= "2026-10-28")) expect(run.influencerPositions.map(p => p.symbol)).toContain("AMZN");
      expect(runs.flatMap(x => x.trades).filter(t => t.symbol === "AMZN").every(t => t.strategy === "influencer")).toBe(true);
      expect(runs.find(x => x.date === "2026-10-27")!.influencerPositions.map(p => p.symbol)).toEqual(["PLTR"]);
    } finally { restore(); }
  });
  test("refuses when an EARLIER run already marks it main (drop-check would keep the main stop)", async () => {
    const { tagSleeveFrom } = await import("@/lib/run-store");
    store = [mk("2026-10-29", "14:30", ["AMZN"], []), mk("2026-10-28", "14:30", ["AMZN"], [], [["AMZN", "main"]])];
    install();
    try {
      const r = await tagSleeveFrom("2026-10-29", "AMZN", "influencer");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("re-run from 2026-10-28");
    } finally { restore(); }
  });
  test("a CLOSED earlier main holding is refused outright — never 're-run from' old history", async () => {
    const { tagSleeveFrom } = await import("@/lib/run-store");
    store = [mk("2026-10-28", "14:30", ["AMZN"], []), mk("2026-10-27", "14:30", [], []),
      mk("2026-08-03", "14:30", ["AMZN"], [], [["AMZN", "main"]])];
    install();
    try {
      const r = await tagSleeveFrom("2026-10-28", "AMZN", "influencer");
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.reason).toContain("CLOSED main-book holding"); expect(r.reason).not.toContain("re-run from"); }
    } finally { restore(); }
  });
  test("a main buy in a PRE-TRACKING run still blocks (stopouts counts it)", async () => {
    const { tagSleeveFrom } = await import("@/lib/run-store");
    const old = mk("2026-06-01", "14:30", ["AMZN"], [], [["AMZN", "main"]]); delete (old as { influencerPositions?: unknown }).influencerPositions;
    store = [mk("2026-10-28", "14:30", ["AMZN"], []), mk("2026-10-27", "14:30", [], []), old];
    install();
    try { expect((await tagSleeveFrom("2026-10-28", "AMZN", "influencer")).ok).toBe(false); } finally { restore(); }
  });
  test("a pre-tracking run INSIDE the range is refused (its main buy would still count)", async () => {
    const { tagSleeveFrom } = await import("@/lib/run-store");
    const old = mk("2026-06-12", "14:30", ["AMZN"], [], [["AMZN", "main"]]); delete (old as { influencerPositions?: unknown }).influencerPositions;
    store = [mk("2026-10-28", "14:30", ["AMZN"], []), old];
    install();
    try {
      const r = await tagSleeveFrom("2026-06-12", "AMZN", "influencer");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("before sleeve tracking");
    } finally { restore(); }
  });
  test("→ main on a name no run holds (typo) is refused, not 'already labelled'", async () => {
    const { tagSleeveFrom } = await import("@/lib/run-store");
    store = [mk("2026-10-28", "14:30", ["AMZN"], [])];
    install();
    try {
      const r = await tagSleeveFrom("2026-10-28", "AMZNN", "main");
      expect(r.ok).toBe(false);
    } finally { restore(); }
    expect(process.env.UPSTASH_REDIS_REST_URL).not.toBe("https://stub");
  });
  test("refuses when nothing would carry forward (not held), and when a run is saved meanwhile", async () => {
    const { tagSleeveFrom } = await import("@/lib/run-store");
    store = [mk("2026-10-28", "14:30", ["PLTR"], ["PLTR"])];
    install();
    try {
      const r = await tagSleeveFrom("2026-10-28", "AMZN", "influencer");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("nothing would carry forward");
    } finally { restore(); }
    store = [mk("2026-10-28", "14:30", ["AMZN"], [])];
    saveDuringWrite = true; install();
    try {
      const r = await tagSleeveFrom("2026-10-28", "AMZN", "influencer");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("saved meanwhile");
    } finally { restore(); }
  });
});
