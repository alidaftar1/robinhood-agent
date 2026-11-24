import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { daysMissingReturn, recentDaysMissingReturn, MAX_RUNS, type TradeRun } from "../lib/run-store";

const d = (date: string, agenticDailyReturn: number | null | undefined, mainDailyReturn: number | null | undefined = agenticDailyReturn, t = "15:30") =>
  ({ date, timestamp: `${date}T${t}:00.000Z`, summary: "", positions: [], trades: [], influencerPositions: [], personal: null,
    portfolioAfter: { totalValue: "1", cash: "0", equity: "1" }, agenticDailyReturn, mainDailyReturn }) as unknown as TradeRun;
const dates = (r: TradeRun[], before = "2026-11-24") => daysMissingReturn(r, "2026-07-11", before);
const src = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("a day with no stored return is visible", () => {
  test("null and undefined are missing; 0 is a real return; before the window is ignored", () => {
    expect(dates([d("2026-11-23", 0.05), d("2026-11-20", undefined), d("2026-11-19", 0), d("2026-11-18", null), d("2026-06-22", null)]))
      .toEqual(["2026-11-18", "2026-11-20"]);
  });
  test("control: a complete record is silent", () => expect(dates([d("2026-11-23", 0.05), d("2026-11-20", -0.07)])).toEqual([]));
  test("today is not judged", () => expect(dates([d("2026-11-24", null), d("2026-11-23", 0.05)])).toEqual([]));
  test("a thin intraday row does not make its date blank", () => {
    expect(dates([d("2026-11-23", null, null, "18:00"), d("2026-11-23", 0.05)])).toEqual([]);
  });
  test("today counts once locked", () => {
    expect(dates([{ ...d("2026-11-24", null), returnLocked: true }, d("2026-11-23", 0.05)])).toEqual(["2026-11-24"]);
  });
  test("a sleeve-only null (empty or rebuilt sleeve) is not a gap", () => {
    expect(dates([d("2026-11-23", 0.05, null)])).toEqual([]);
  });
  test("the email mentions only the three run dates before today", () => {
    const r = ["23", "20", "19", "18"].map(x => d(`2026-11-${x}`, null));
    expect(recentDaysMissingReturn([d("2026-11-24", null), ...r], "2026-07-11", "2026-11-24")).toEqual(["2026-11-19", "2026-11-20", "2026-11-23"]);
  });
  test("the email mentions today once locked", () => {
    expect(recentDaysMissingReturn([{ ...d("2026-11-24", null), returnLocked: true }, d("2026-11-23", 0.05)], "2026-07-11", "2026-11-24")).toEqual(["2026-11-24"]);
  });
  test("Fix 2 counts only a numeric return as a repair", () => {
    expect(src("app/api/autopilot/route.ts")).toContain("/return = -?\\d/.test(msg)");
    const ok = /return = -?\d/;
    expect(ok.test("2026-11-20: return = -7.58%, main sleeve = -8.39%")).toBe(true);
    expect(ok.test("2026-11-20: return = null, main sleeve = null")).toBe(false);
    expect(ok.test("2026-11-20: skipped — return is locked")).toBe(false);
  });
  test("a full read does not judge its oldest date, and still judges the rest", () => {
    const full = [d("2026-11-23", 0.05), d("2026-11-20", null), ...Array.from({ length: MAX_RUNS - 2 }, () => d("2026-11-19", null))];
    expect(dates(full)).toEqual(["2026-11-20"]);
    expect(dates(full.slice(1))).toEqual(["2026-11-19", "2026-11-20"]);
  });
  test("wired: dashboard renders it; autopilot reports it softly, flags an empty read, prescribes no unlock", () => {
    expect(src("app/dashboard-view.tsx")).toContain("missingDays.length > 0 &&");
    const a = src("app/api/autopilot/route.ts");
    const block = a.slice(a.indexOf("const all = await getRuns(MAX_RUNS)"), a.indexOf("// Fix 3: Bogus"));
    expect(block).toContain("recentDaysMissingReturn(all, V1_TRACK_START, today)");
    expect(block).toContain("all.length === 0) softIssues.push");
    expect(block).toContain("} catch (e) {");
    expect(block).not.toContain("unlock");
    expect(block).not.toMatch(/[^t]issues\.push/);
  });
});
