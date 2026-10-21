import { describe, test, expect } from "bun:test";
import { passAtK, formatAttemptLog, type AttemptLog } from "./pass-at-k";

// ─────────────────────────────────────────────────────────────────────────────
// The guard on the guard. pass@K exists to absorb a single unlucky draw from a
// sampled model — NOT to make a failing test green. These pin both halves,
// because the dangerous failure mode of a retry wrapper is that it quietly
// swallows a real regression.
// ─────────────────────────────────────────────────────────────────────────────
describe("pass@K absorbs a flake and still fails a regression", () => {
  test("a first-attempt pass runs exactly once — a healthy suite costs what it did before", async () => {
    let calls = 0;
    await passAtK("ok", 3, async () => { calls++; });
    expect(calls).toBe(1);
  });

  test("a flake that passes on the second draw passes, and stops there", async () => {
    let calls = 0;
    await passAtK("flaky", 3, async () => { calls++; if (calls < 2) throw new Error("unlucky draw"); });
    expect(calls).toBe(2);   // early exit — the third draw is never spent
  });

  test("a REGRESSION fails all K and still throws — this is the half that matters", async () => {
    let calls = 0;
    await expect(passAtK("broken", 3, async () => { calls++; throw new Error("always broken"); }))
      .rejects.toThrow(/failed all 3 attempts/);
    expect(calls).toBe(3);
  });

  test("the failure message carries EVERY attempt, not just the last", async () => {
    // K identical messages say "broken"; K different ones say something stranger is happening.
    let n = 0;
    try {
      await passAtK("varied", 3, async () => { n++; throw new Error(`distinct failure ${n}`); });
      throw new Error("should not reach");
    } catch (e) {
      const msg = (e as Error).message;
      for (const i of [1, 2, 3]) expect(msg).toContain(`distinct failure ${i}`);
    }
  });

  test("K=1 is the old behaviour exactly — no retry, no absorption", async () => {
    let calls = 0;
    await expect(passAtK("single", 1, async () => { calls++; throw new Error("x"); })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("the report sorts worst-first, so a degrading test surfaces before it goes red", () => {
    const log: AttemptLog[] = [
      { label: "easy", attempts: 1, passed: true, failures: [] },
      { label: "degrading", attempts: 3, passed: true, failures: ["a", "b"] },
      { label: "broken", attempts: 3, passed: false, failures: ["a", "b", "c"] },
    ];
    const lines = formatAttemptLog(log).split("\n").slice(1);
    expect(lines[0]).toContain("broken");       // 3 attempts, failed
    expect(lines[1]).toContain("degrading");    // 3 attempts, passed
    expect(lines[2]).toContain("easy");
    expect(formatAttemptLog([])).toBe("");      // silent when nothing sampled
  });
});
