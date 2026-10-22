import { describe, test, expect } from "bun:test";
import { classifyNoTradeState } from "@/lib/no-trade-cause";

// ─────────────────────────────────────────────────────────────────────────────
// WHY THE TRADE LIST WAS EMPTY — behaviour, not source structure.
//
// 2026-10-13: every guard behaved correctly (GOOGL and TGT dropped at the
// 6-position cap, both notes recorded) and the autopilot still flipped the whole
// morning report to NEEDS ATTENTION on "possible analysis issue". Suppressing
// that is easy; suppressing it SAFELY is the problem, because the
// imminent-earnings gate fails CLOSED — a dead Finnhub key drops every buy and
// writes a DROPPED note for each, which the naive suppression reads as "guards
// working" and logs away. So the day the data dies is the day the report goes
// quiet, and it looks identical to a healthy day in the email.
//
// This file exists because the first version of this check was pinned only by a
// source-structure assertion, and `if (false && unestablished.length > 0)` passed
// it. A structural test cannot see a disabled branch.
// ─────────────────────────────────────────────────────────────────────────────
const CAP = "GOOGL buy DROPPED — main book at its 6-position cap (6 held at the start; no slots were open; 0 left for GOOGL)";
const UNKNOWN = 'AAA buy DROPPED — could NOT establish an earnings date (the per-symbol lookup returned no answer for it). Withheld rather than buying into an unknown print; this says our lookup failed, NOT that AAA is reporting.';
const UNPARSEABLE = 'BBB buy DROPPED — its earnings date "garbage" could not be parsed, so we could not establish how far away the print is.';
const IMMINENT = "CCC buy DROPPED — ⚠⚠ IMMINENT EARNINGS 2026-10-15 (1d away; the rule is ≤3d). Hard no-buy rule, enforced in code.";

describe("an empty trade list is classified by WHY, with a missing input outranking a decision", () => {
  test("a cap drop is EXPLAINED — the analysis produced buys, the code refused them", () => {
    expect(classifyNoTradeState([CAP]).cause).toBe("explained");
  });

  test("no notes at all is UNEXPLAINED — the real anomaly, and still worth raising", () => {
    expect(classifyNoTradeState([]).cause).toBe("unexplained");
    expect(classifyNoTradeState(["CONTEXT — P/E withheld for: MU (reported 2026-09-30)"]).cause).toBe("unexplained");
  });

  test("an unestablished earnings date is a DATA FAILURE, never 'explained'", () => {
    for (const n of [UNKNOWN, UNPARSEABLE]) {
      const r = classifyNoTradeState([n]);
      expect(r.cause).toBe("data-failure");
      expect(r.unestablished).toBe(1);
    }
  });

  test("ORDER: a data failure outranks a legitimate guard drop in the SAME run", () => {
    // The live shape of a broken Finnhub run: some buys die at the cap, others die unestablished.
    // Reading the cap note first would silence the outage. Both orderings of the array, so the
    // result cannot depend on which note happens to come first.
    for (const notes of [[CAP, UNKNOWN], [UNKNOWN, CAP], [CAP, IMMINENT, UNPARSEABLE]]) {
      expect(classifyNoTradeState(notes).cause).toBe("data-failure");
    }
  });

  test("it counts every withheld name, because one timeout and a dead key look different", () => {
    expect(classifyNoTradeState([UNKNOWN, UNPARSEABLE, CAP]).unestablished).toBe(2);
  });

  test("an IMMINENT drop is a decision, not a data failure — the gate worked", () => {
    // The distinction the two note sentences exist to preserve: one asserts a print IS coming
    // (we established it), the other asserts only that we could not establish anything.
    const r = classifyNoTradeState([IMMINENT]);
    expect(r.cause).toBe("explained");
    expect(r.unestablished).toBe(0);
  });

  test("CONTROL: lowercase speculation does NOT count as a drop", () => {
    // lib/buy-sizing emits prose about a buy that was NOT dropped ("...may be rejected or crowd out
    // later buys"). Matching it would explain away a genuine execution failure.
    expect(classifyNoTradeState(["AAA $200→$150 (shrunk to fit budget), may be rejected or crowd out later buys"]).cause)
      .toBe("unexplained");
    expect(classifyNoTradeState(["AAA buy DID NOT CONFIRM after retry"]).cause).toBe("unexplained");
  });

  // WIDENED 2026-10-22. Three gates emit the "could NOT establish" shape and only the earnings one
  // was recognised, so a sector- or momentum-data outage classified as "explained" — a guard doing
  // its job — which is how the 2026-10-22 sleeve drop got reported as a concentration decision when
  // the real cause was a name with no data at all. One case per emitting gate, so a future narrowing
  // of the predicate fails here rather than going quiet in the report.
  test("a missing SECTOR is a data failure, not a guard decision", () => {
    const r = classifyNoTradeState([
      "SPCX buy DROPPED — could NOT establish its sector, so it cannot be counted against the 40% sector budget.",
    ]);
    expect(r.cause).toBe("data-failure");
  });

  test("a missing MOMENTUM reading is a data failure, not a guard decision", () => {
    const r = classifyNoTradeState([
      "MU buy DROPPED — could NOT establish a momentum/trend reading, so the ⛔DOWNTREND screen could not run.",
    ]);
    expect(r.cause).toBe("data-failure");
  });

  test("CONTROL: a genuine guard decision is still 'explained', not inflated to a data failure", () => {
    // The widening must not swallow the ordinary case — a real cap/cooldown drop states a fact we DID
    // establish, and reporting it as a data outage would be the opposite error.
    const r = classifyNoTradeState([
      "ROST buy DROPPED — main book at its 7-position cap (7 held at the start; no slots were open; 0 left for ROST)",
    ]);
    expect(r.cause).toBe("explained");
  });
});
