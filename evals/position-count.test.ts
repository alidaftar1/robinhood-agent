import { describe, test, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { TARGET_MAIN_POSITIONS } from "@/lib/position-target";

// The prompt already argued for concentration ("a concentrated ~6-name book beats a long thin
// tail") but never showed whether the book COMPLIED — it listed holdings and never counted them.
// So the model had no way to know it was holding 12 against a 6-name design, which is how the
// count ratcheted to $201 positions against a ~$402 target. This surfaces the missing input.
const pos = (symbol: string) => ({ symbol, quantity: "1", avgCost: "100", price: 101, heldDays: 5 });
const promptFor = (symbols: string[], influencerHeld: string[] = []) =>
  buildV1AnalysisPrompt(
    "2026-09-29", "",
    { buyingPower: "$2.44", totalValue: "$2413", positions: symbols.map(pos) } as never,
    undefined, undefined, influencerHeld,
  );
const countLine = (symbols: string[], influencerHeld: string[] = []) =>
  promptFor(symbols, influencerHeld).split("\n").find(l => l.includes("MAIN-BOOK POSITIONS")) ?? "";

describe("the model can see its position count against target", () => {
  test("the live shape: 12 held, 1 of them influencer, reads as 11 main vs target", () => {
    const line = countLine(
      ["NVDA", "MRK", "APA", "ILMN", "TRGP", "LLY", "HWM", "TGT", "NEM", "MRVL", "EXPD", "KO"],
      ["NVDA"],
    );
    expect(line).toContain("11 held");
    expect(line).toContain(`target of ~${TARGET_MAIN_POSITIONS}`);
    expect(line).toContain("5 OVER target");
  });

  test("influencer holdings are EXCLUDED — the sleeve has its own 2-slot cap", () => {
    // Counting them would overstate the main book and could push the model to sell a main name to
    // fix a number the sleeve owns.
    expect(countLine(["A", "B", "C"], ["A", "B"])).toContain("1 held");
  });

  test("at or under target it says so without a lecture", () => {
    const line = countLine(["A", "B", "C", "D", "E", "F"]);
    expect(line).toContain("6 held");
    expect(line).not.toContain("OVER target");
  });

  test("it states the DILUTION, which is the part that matters", () => {
    // 12 main names means each position is ~50% of designed size. The count alone is abstract;
    // the size consequence is the thing that explains an index-clone book.
    const line = countLine(Array.from({ length: 12 }, (_, i) => `S${i}`));
    expect(line).toMatch(/roughly 50% of the size/);
  });

  test("it is stated as CONTEXT, not as an order to sell", () => {
    // Step 1 is instrumentation. The loss-discipline, time-stop and hysteresis rules decide sells;
    // a count line that reads as "sell down to 6" would be a trading change smuggled in as a metric.
    const line = countLine(Array.from({ length: 12 }, (_, i) => `S${i}`));
    expect(line).toMatch(/NOT an instruction to sell/);
    expect(line).toMatch(/unchanged/);
  });

  test("an empty book does not render a spurious over-target warning", () => {
    expect(countLine([])).not.toContain("OVER target");
  });
});
