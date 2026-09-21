import { describe, expect, test } from "bun:test";
import { MAX_RUNS } from "@/lib/run-store";

// lib/run-store has paths that DEL the runs key and RPUSH back whatever they just read. Any record
// outside that read window is destroyed permanently. They read a hardcoded `getRuns(90)`, which was
// lossless ONLY while 90 happened to equal MAX_RUNS — raising the cap to 150 silently turned every
// patch call (patchDate, dedupe, clearReturnForDate, patchPositionPrice, setInfluencerReturn) into a
// truncation of the oldest live trading history. This guards the coupling rather than the constant.
describe("run-store retention", () => {
  test("every path that DELETES the runs key reads MAX_RUNS, not a literal", async () => {
    // Narrow on purpose: small READ-ONLY windows like getRuns(1) / getRuns(10) are fine. What is
    // never safe is reading a fixed window and then rewriting the whole key from it.
    const src = await Bun.file("lib/run-store.ts").text();
    const offenders: string[] = [];
    for (const m of src.matchAll(/\["DEL",\s*RUNS_KEY\]/g)) {
      const preceding = src.slice(Math.max(0, m.index! - 1200), m.index!);
      const reads = [...preceding.matchAll(/getRuns\(([^)]*)\)/g)];
      const last = reads[reads.length - 1]?.[1]?.trim();
      if (last && last !== "MAX_RUNS") offenders.push(`getRuns(${last}) precedes a DEL+RPUSH`);
    }
    expect({ offenders }).toEqual({ offenders: [] });
  });

  test("MAX_RUNS is large enough for the main-book staleness clock", async () => {
    // heldDaysOf needs STALE_DAYS distinct DATES, and several routes write more than one record per
    // date (~1.2 observed), so records must exceed dates with real headroom or the time-stop is
    // dead code that still renders its rule into every prompt.
    const { STALE_DAYS } = await import("@/lib/strategy");
    const observedRecordsPerDate = 1.2;
    expect(MAX_RUNS / observedRecordsPerDate).toBeGreaterThan(STALE_DAYS * 1.5);
  });
});
