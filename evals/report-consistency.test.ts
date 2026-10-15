import { describe, test, expect } from "bun:test";
import { findReportContradictions } from "@/lib/report-consistency";

// ─────────────────────────────────────────────────────────────────────────────
// Each case below is a REAL report this system sent, or nearly sent, between
// 2026-10-13 and 10-15. The strings are the production ones.
//
// Direction rule: a FALSE POSITIVE here is expensive in a specific way — it
// flips the banner on a healthy day, and a banner that cries wolf is the exact
// failure three of these four incidents are about. So every check is a pair
// that is provably incompatible, and the controls matter as much as the hits.
// ─────────────────────────────────────────────────────────────────────────────
const base = { notes: [], issues: [], autoFixed: [], discrepancies: [], captureReconciles: null };
const ids = (i: Parameters<typeof findReportContradictions>[0]) =>
  findReportContradictions(i).map(c => c.id);

describe("the report is checked against itself", () => {
  test("2026-10-15: WITHHELD and 'permanent gap' in the same run", () => {
    expect(ids({ ...base, notes: [
      "Return WITHHELD — holdings disagree with the trade records (NVDA -0.217420, MRVL (shares-appeared)). Almost always the owner's own manual fills, which /api/verify?capture=1 records from the broker in the 8am run; the day's return is computed then rather than published now from a book that does not add up.",
      "DAILY RETURN NOT COMPUTED — an unknown condition, so there is no baseline to measure today against. Today's return is a permanent gap unless the prior run's total value is corrected.",
    ] })).toContain("withheld-vs-uncomputable");
  });

  test("2026-10-14: the same fill recorded in autoFixed and uncaptured in issues", () => {
    expect(ids({ ...base,
      autoFixed: ["Recorded 1 of your own fill(s) from the broker: buy MRVL x0.000269 @$260.12[main]."],
      issues: ["Live verify: Uncaptured order: buy MRVL ×0.000269 @$260.12 (filled)"],
    })).toContain("recorded-and-uncaptured");
  });

  test("...matched on SYMBOL + SIDE + QUANTITY, never the symbol alone", () => {
    // Registry #1: two lists joined on vibes. A recorded BUY does not explain an uncaptured SELL,
    // and a different symbol explains nothing.
    const otherSide = ids({ ...base,
      autoFixed: ["Recorded 1 of your own fill(s) from the broker: buy MRVL x0.69 @$253.66[main]."],
      issues: ["Live verify: Uncaptured order: sell MRVL ×0.69 @$252.09 (filled)"] });
    expect(otherSide).not.toContain("recorded-and-uncaptured");
    const otherSym = ids({ ...base,
      autoFixed: ["Recorded 1 of your own fill(s) from the broker: buy NVDA x0.69 @$253.66[main]."],
      issues: ["Live verify: Uncaptured order: buy MRVL ×0.69 @$253.66 (filled)"] });
    expect(otherSym).not.toContain("recorded-and-uncaptured");
  });

  test("...and survives the broker's 2dp rounding, which defeated an exact check once already", () => {
    expect(ids({ ...base,
      autoFixed: ["Recorded 1 of your own fill(s) from the broker: sell MRVL x1.190290 @$231.00[main]."],
      issues: ["Live verify: Uncaptured order: sell MRVL ×1.19 @$231.00 (filled)"],
    })).toContain("recorded-and-uncaptured");
  });

  test("2026-10-14: reconciles=true beside an open live-vs-stored difference", () => {
    expect(ids({ ...base, captureReconciles: true,
      discrepancies: ["MRVL: quantity mismatch — live 1.523460 vs stored 1.111172"],
    })).toContain("reconciles-vs-live-mismatch");
  });

  test("2026-10-13: 'possible analysis issue' beside a note explaining the empty trade list", () => {
    expect(ids({ ...base,
      issues: ["No trades executed but buying power is $174.68 — possible analysis issue (main-book buys were OPEN today)."],
      notes: ["GOOGL buy DROPPED — main book at its 6-position cap (6 held at the start; no slots were open; 0 left for GOOGL)"],
    })).toContain("no-trades-vs-explained");
  });

  test("a line that names no established cause is itself the defect", () => {
    expect(ids({ ...base, notes: ["DAILY RETURN NOT COMPUTED — an unknown condition, so there is no baseline."] }))
      .toContain("unnamed-cause");
  });

  test("CONTROLS: an ordinary healthy report raises nothing", () => {
    expect(findReportContradictions({ ...base,
      notes: ["CONTEXT — conviction research shown to the model: 2026-09-21 (24d old)",
              "GOOGL buy DROPPED — main book at its 7-position cap (7 held at the start)"],
      issues: [], autoFixed: ["Recorded 1 of your own fill(s) from the broker: sell NVDA x0.217420 @$220.61[influencer]."],
      discrepancies: [], captureReconciles: true,
    })).toEqual([]);
  });

  test("CONTROL: a withheld return ALONE is correct and must not be flagged", () => {
    // Withholding is the designed, self-healing state. Flagging it would make the check itself the
    // next banner that cries wolf.
    expect(findReportContradictions({ ...base,
      notes: ["Return WITHHELD — holdings disagree with the trade records (MRVL (shares-appeared))."],
    })).toEqual([]);
  });

  test("CONTROL: a GENUINELY uncomputable return alone is not a contradiction", () => {
    // The mirror of the test above, and the one that was missing: "DAILY RETURN NOT COMPUTED" on
    // its own is a REAL alert about a real permanent gap (an unpriceable fill, a zero baseline).
    // Labelling it a report contradiction would suppress the one case that genuinely needs a
    // human. Only the PAIR is wrong. A mutation that fired this pair on one half passed until
    // this test existed.
    expect(ids({ ...base, notes: [
      "DAILY RETURN NOT COMPUTED — sell AAA x1.5 has no usable price in either day's snapshot; today's return is a permanent gap unless the fill price is supplied.",
    ] })).not.toContain("withheld-vs-uncomputable");
  });

  test("CONTROL: reconciles=true with no live-vs-stored difference is fine", () => {
    expect(findReportContradictions({ ...base, captureReconciles: true,
      discrepancies: ["Uncaptured order: buy ROST ×0.71 @$225.64 (filled)"] })).toEqual([]);
  });

  test("CONTROL: an empty report is silent, not vacuously noisy", () => {
    expect(findReportContradictions(base)).toEqual([]);
  });
});
