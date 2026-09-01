import { describe, expect, test } from "bun:test";
import { formatV1Shortlist } from "../lib/market-data";
import { formatInfluencerSignals } from "../lib/influencer-signals";
import { formatEarningsRecord, type EarningsBeatRecord, type RecentEarnings } from "../lib/earnings";

// The 2026-09-01 gap: the post-earnings BUY screen carves out "a serial beater with a strong
// 📈EARN-RECORD", but the record was only ever fetched/rendered for HELD names. CRM — the run's
// highest influencer net score (5) — was skipped as a "+27% one-time earnings gap" with its beat
// record never shown, so the model could only ever apply half of the rule.

const REPORTED: RecentEarnings = { date: "2026-08-27", daysAgo: 5 };
const SERIAL_BEATER: EarningsBeatRecord = { beats: 4, total: 4, avgSurprisePct: 12.4 };
const COIN_FLIP: EarningsBeatRecord = { beats: 2, total: 4, avgSurprisePct: 0.3 };

const mkStock = (symbol: string, change5d = 25) => ({
  symbol, price: 258, change1d: 1, change5d, change14d: 0, change30d: 0, distFrom52wHigh: 0,
  volatility30d: 20, sharpe5d: 0, sharpe14d: 0, sharpe30d: 0, mom12_1: 40, beta: 1,
  earningsDate: null, relStrength1d: 0, relStrength5d: 0, relStrength14d: 0, relStrength30d: 0,
}) as any;

/** The candidate's own ROW — the section's rule text also names the tag, so assert on the row. */
const rowFor = (section: string, ticker: string) =>
  section.split("\n").find(l => /^[🔥📺]/.test(l) && l.includes(ticker)) ?? "";

const cache = (ticker: string) => ({
  refreshedAt: "2026-09-01T13:00:00Z",
  signals: [{ tickers: [ticker], channelName: "Meet Kevin", confidence: "high" }],
  tickerCounts: { [ticker]: 5 },
  avoidCounts: {},
}) as any;

describe("formatEarningsRecord", () => {
  test("renders beats, total and a signed average", () => {
    expect(formatEarningsRecord(SERIAL_BEATER)).toBe("  📈EARN-RECORD beat 4/4, avg +12% surprise");
  });

  test("rounds before signing so a tiny negative never prints as -0%", () => {
    expect(formatEarningsRecord({ beats: 2, total: 4, avgSurprisePct: -0.2 })).toContain("avg +0% surprise");
  });

  test("absent record renders nothing", () => {
    expect(formatEarningsRecord(undefined)).toBe("");
  });
});

describe("influencer candidate rows expose the post-earnings carve-out", () => {
  test("a 📊REPORTED pick shows its 📈EARN-RECORD", () => {
    const out = formatInfluencerSignals(
      cache("CRM"), new Map([["CRM", 258]]),
      new Map([["CRM", { change1d: 1, change5d: 25, distFromHigh: -1, aboveShortMA: true }]] as any),
      new Map([["CRM", REPORTED]]), new Map(), "2026-09-01", new Map(),
      new Map([["CRM", SERIAL_BEATER]]),
    );
    expect(rowFor(out, "CRM")).toContain("📊"); // the REPORTED flag that triggers the screen
    expect(rowFor(out, "CRM")).toMatch(/📈EARN-RECORD beat 4\/4/);
  });

  test("a weak record still renders — the screen needs the coin-flip case too", () => {
    const out = formatInfluencerSignals(
      cache("CRM"), new Map([["CRM", 258]]),
      new Map([["CRM", { change1d: 1, change5d: 25, distFromHigh: -1, aboveShortMA: true }]] as any),
      new Map([["CRM", REPORTED]]), new Map(), "2026-09-01", new Map(),
      new Map([["CRM", COIN_FLIP]]),
    );
    expect(rowFor(out, "CRM")).toMatch(/📈EARN-RECORD beat 2\/4/);
  });

  test("a pick that did NOT just report carries no record (noise otherwise)", () => {
    const out = formatInfluencerSignals(
      cache("AMD"), new Map([["AMD", 458]]),
      new Map([["AMD", { change1d: -1, change5d: -4, distFromHigh: -6, aboveShortMA: true }]] as any),
      new Map(), new Map(), "2026-09-01", new Map(),
      new Map([["AMD", SERIAL_BEATER]]),
    );
    expect(rowFor(out, "AMD")).toContain("AMD");
    expect(rowFor(out, "AMD")).not.toContain("EARN-RECORD");
  });

  test("no beat data available → row still renders, just without the record", () => {
    const out = formatInfluencerSignals(
      cache("CRM"), new Map([["CRM", 258]]),
      new Map([["CRM", { change1d: 1, change5d: 25, distFromHigh: -1, aboveShortMA: true }]] as any),
      new Map([["CRM", REPORTED]]), new Map(), "2026-09-01", new Map(),
      new Map(),
    );
    expect(rowFor(out, "CRM")).toContain("📊"); // still flagged as just-reported
    expect(rowFor(out, "CRM")).not.toContain("EARN-RECORD");
  });

  test("the sleeve rule now points at the tag, so skipping a high-net pick is accountable", () => {
    const out = formatInfluencerSignals(cache("CRM"), new Map([["CRM", 258]]));
    expect(out).toContain("📈EARN-RECORD");
    expect(out).toMatch(/if you skip a high-net pick on this screen/i);
  });
});

describe("main shortlist rows expose the same carve-out", () => {
  test("a 📊REPORTED shortlist candidate shows its 📈EARN-RECORD", () => {
    const table = formatV1Shortlist(
      [mkStock("CRM")], { CRM: { quality: 0.8 } }, {}, {}, new Set(), new Map(),
      new Map([["CRM", REPORTED]]), new Map(), new Map([["CRM", SERIAL_BEATER]]),
    );
    expect(table).toMatch(/CRM.*📈EARN-RECORD beat 4\/4, avg \+12% surprise/);
  });

  test("a candidate with no fresh print shows no record", () => {
    const table = formatV1Shortlist(
      [mkStock("HWM")], { HWM: { quality: 0.8 } }, {}, {}, new Set(), new Map(),
      new Map(), new Map(), new Map([["HWM", SERIAL_BEATER]]),
    );
    expect(table).not.toContain("EARN-RECORD");
  });

  test("omitting the beatHistory argument entirely is safe (default empty map)", () => {
    const table = formatV1Shortlist(
      [mkStock("CRM")], { CRM: { quality: 0.8 } }, {}, {}, new Set(), new Map(),
      new Map([["CRM", REPORTED]]),
    );
    expect(table).toContain("CRM");
    expect(table).not.toContain("EARN-RECORD");
  });
});
