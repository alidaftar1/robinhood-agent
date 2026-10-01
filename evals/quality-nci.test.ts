import { describe, test, expect } from "bun:test";
import { adjustForNci, NCI_IMMATERIAL_FRACTION, type ConceptFact } from "@/lib/quality";

// The withheld set was SECTOR-SHAPED — XLU 24%, XLB 21%, XLRE 19%, XLE 13%, zero in XLK/XLV/XLP —
// because the lookup asked only for us-gaap:NetIncomeLoss and those filers tag ProfitLoss instead.
//
// The obvious fix is worse than the bug. NetIncomeLoss is attributable to the PARENT; ProfitLoss
// INCLUDES noncontrolling interests. Measured live: FCX's NCI is 46.9% of its ProfitLoss and SPG's is
// 13.7%, so substituting one for the other would nearly DOUBLE Freeport — fail-open, on exactly the
// sectors the bias already disadvantages.

const f = (val: number, start = "2025-01-01", end = "2025-12-31", filed = "2026-02-01"): ConceptFact =>
  ({ val, start, end, filed, form: "10-K" });

describe("adjustForNci derives parent income rather than substituting", () => {
  test("THE FCX CASE: a 46.9% NCI is subtracted, not swallowed", () => {
    // ProfitLoss 4.15B with NCI 1.95B → parent 2.20B. Using ProfitLoss raw would overstate by 89%.
    const out = adjustForNci([f(4.15e9)], [f(1.95e9)])!;
    expect(out[0].val).toBeCloseTo(2.20e9, 0);
    expect(out[0].val).not.toBeCloseTo(4.15e9, 0);
  });

  test("a NEGATIVE NCI raises parent income — DOW's minorities took a loss", () => {
    // Subtracting a negative must ADD. Special-casing the sign would get this backwards.
    const out = adjustForNci([f(-2.44e9)], [f(0.18e9 * -1)])!;
    expect(out[0].val).toBeCloseTo(-2.44e9 + 0.18e9, 0);
    expect(out[0].val).toBeGreaterThan(-2.44e9);
  });

  test("every period is adjusted independently, matched by its own dates", () => {
    const pl = [f(100, "2025-01-01", "2025-12-31"), f(30, "2026-01-01", "2026-03-31")];
    const nci = [f(10, "2025-01-01", "2025-12-31"), f(4, "2026-01-01", "2026-03-31")];
    const out = adjustForNci(pl, nci)!;
    expect(out.map(x => x.val)).toEqual([90, 26]);
  });

  test("a restated NCI for the same period keeps the LATEST filed", () => {
    const nci = [f(10, "2025-01-01", "2025-12-31", "2026-02-01"), f(15, "2025-01-01", "2025-12-31", "2026-06-01")];
    expect(adjustForNci([f(100)], nci)![0].val).toBe(85);
  });
});

describe("when the matching NCI is missing, the rule is explicit", () => {
  test("no NCI anywhere → the filer has no minority interests → unadjusted", () => {
    expect(adjustForNci([f(100)], [])![0].val).toBe(100);
  });

  test("a STALE but IMMATERIAL NCI is treated as zero — V's is 0.00", () => {
    const stale = [f(0, "2014-01-01", "2014-12-31", "2015-02-01")];
    expect(adjustForNci([f(20.06e9)], stale)![0].val).toBeCloseTo(20.06e9, 0);
  });

  test("a STALE but MATERIAL NCI WITHHOLDS the whole filer — the key safety case", () => {
    // We cannot size an adjustment we cannot see, and the unadjusted figure would overstate by
    // exactly the amount that matters. Withholding costs only opportunity.
    const stale = [f(1.95e9, "2023-01-01", "2023-12-31", "2024-02-01")];
    expect(adjustForNci([f(4.15e9)], stale)).toBeNull();
  });

  test("the materiality threshold is the documented one and actually bites", () => {
    const pl = [f(1000)];
    // 0.9% of ProfitLoss → treated as zero; 1.1% → withheld.
    expect(adjustForNci(pl, [f(9, "2020-01-01", "2020-12-31")])![0].val).toBe(1000);
    expect(adjustForNci(pl, [f(11, "2020-01-01", "2020-12-31")])).toBeNull();
    expect(NCI_IMMATERIAL_FRACTION).toBe(0.01);
  });

  test("an unsized period is DROPPED, and the sizable ones survive", () => {
    // The first version returned null for the whole filer here, which withheld VISA: 210 ProfitLoss
    // facts back to 2008, one ancient small-value period failing the ratio against the all-time max
    // NCI, despite every recent period being cleanly adjustable. Dropping is safe because
    // ttmFromFacts requires contiguity — a missing period cannot be silently substituted.
    const pl = [
      f(100, "2025-01-01", "2025-12-31"),      // sizable: NCI for this exact period exists
      f(50, "2009-01-01", "2009-12-31"),       // ancient, small, no matching NCI -> unsizable
    ];
    const nci = [f(10, "2025-01-01", "2025-12-31"), f(9, "2019-01-01", "2019-12-31")];
    const out = adjustForNci(pl, nci)!;
    expect(out.map(x => x.end)).toEqual(["2025-12-31"]);
    expect(out[0].val).toBe(90);
  });

  test("if NOTHING is sizable the filer is still withheld", () => {
    const pl = [f(50, "2009-01-01", "2009-12-31")];
    expect(adjustForNci(pl, [f(9, "2019-01-01", "2019-12-31")])).toBeNull();
  });

  test("an empty ProfitLoss series yields null, never a phantom zero", () => {
    expect(adjustForNci([], [f(5)])).toBeNull();
  });
});
