import { describe, expect, test } from "bun:test";
import { noiseFloor, compareToBaseline, runsNeeded } from "./noise-floor";

// Three identical runs of the LLM suite — same commit, no edits — gave 3 / 3 / 1 failures out of
// ~190 checks. Every assertion below is about not mistaking that for a result.
const OBSERVED_LLM_RUNS = [3, 3, 1];

describe("noiseFloor", () => {
  test("a deterministic suite has a floor of exactly zero", () => {
    const f = noiseFloor([0, 0, 0]);
    expect(f.sd).toBe(0);
    expect(f.singleRunFloor).toBe(0);
  });

  test("ONE run leaves the spread UNKNOWN, not zero", () => {
    // Reporting 0 here would declare a single run perfectly repeatable and make every later
    // comparison look significant — the failure that would quietly invert this whole tool.
    const f = noiseFloor([3]);
    expect(f.sd).toBeNaN();
    expect(f.singleRunFloor).toBeNaN();
  });

  test("the measured LLM spread puts a 2-test move inside the noise", () => {
    const f = noiseFloor(OBSERVED_LLM_RUNS);
    expect(f.mean).toBeCloseTo(2.333, 2);
    expect(f.singleRunFloor).toBeGreaterThan(2);   // a 2-test change cannot be read as real
  });

  test("the single-run bound is WIDER than the mean bound", () => {
    // sd vs se. Judging one run with the mean's bound is how a noise result gets called a win.
    const f = noiseFloor(OBSERVED_LLM_RUNS);
    expect(f.singleRunFloor).toBeGreaterThan(f.meanFloor);
  });
});

describe("compareToBaseline", () => {
  test("the real case: 3 failures -> 1 is NOT a result", () => {
    // Exactly the move that occurred with no change at all. If this ever reads as distinguishable,
    // the tool is worse than not having it.
    const v = compareToBaseline(OBSERVED_LLM_RUNS, [1]);
    expect(v.distinguishable).toBe(false);
  });

  test("a large move IS a result", () => {
    expect(compareToBaseline(OBSERVED_LLM_RUNS, [40]).distinguishable).toBe(true);
  });

  test("an unknown floor fails CLOSED — missing evidence is not a pass", () => {
    const v = compareToBaseline([3], [1]);
    expect(v.distinguishable).toBe(false);
    expect(v.reason).toContain("floor is unknown");
  });

  test("on a deterministic suite a single test IS distinguishable", () => {
    // test:fast is reproducible, so there is no floor to clear and 14/20 -> 15/20 is real.
    expect(compareToBaseline([0, 0, 0], [1]).distinguishable).toBe(true);
  });

  test("averaging more candidate runs tightens the bound", () => {
    const one = compareToBaseline(OBSERVED_LLM_RUNS, [0]);
    const many = compareToBaseline(OBSERVED_LLM_RUNS, [0, 0, 0, 0, 0, 0]);
    expect(many.floor).toBeLessThan(one.floor);
  });
});

describe("runsNeeded", () => {
  test("a deterministic suite settles in one run", () => {
    expect(runsNeeded(0, 1)).toBe(1);
  });

  test("resolving a 1-test effect at the measured spread costs many runs", () => {
    // Turns "not distinguishable" into a price: this is why a 1-test improvement is not worth
    // chasing on a 55-minute suite.
    const { sd } = noiseFloor(OBSERVED_LLM_RUNS);
    expect(runsNeeded(sd, 1)).toBeGreaterThan(5);
  });

  test("a bigger effect is cheaper to resolve", () => {
    const { sd } = noiseFloor(OBSERVED_LLM_RUNS);
    expect(runsNeeded(sd, 10)).toBeLessThan(runsNeeded(sd, 1));
  });
});
