import { describe, test, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { TARGET_MAIN_POSITIONS } from "@/lib/position-target";

// The prompt already argued for concentration ("a concentrated ~6-name book beats a long thin
// tail") but never showed whether the book COMPLIED — it listed holdings and never counted them.
// So the model had no way to know it was holding 12 against a 6-name design, which is how the
// count ratcheted to $201 positions against a ~$402 target. This surfaces the missing input.
const pos = (symbol: string) => ({ symbol, quantity: "1", avgCost: "100", price: 101, heldDays: 5 });
const promptFor = (symbols: string[], influencerHeld: string[] = [], isRebalanceDay = true) =>
  buildV1AnalysisPrompt(
    "2026-09-29", "",
    { buyingPower: "$2.44", totalValue: "$2413", positions: symbols.map(pos) } as never,
    undefined, undefined, influencerHeld, [], [], {}, new Map(), new Map(), new Map(), {}, {}, [], "", "", isRebalanceDay,
  );
const countLine = (symbols: string[], influencerHeld: string[] = [], isRebalanceDay = true) => {
  const line = promptFor(symbols, influencerHeld, isRebalanceDay)
    .split("\n").find(l => l.includes("MAIN-BOOK POSITIONS"));
  if (!line) throw new Error("count line not rendered — prompt shape changed");
  return line;
};

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

  test("the BUY allowance cannot be read as a holding target", () => {
    // "pick up to 6" next to "a target of ~6" reads, at 11 held, as either "add 6 more" or
    // "sell 5". Both cannot be right.
    const p = promptFor(Array.from({ length: 12 }, (_, i) => `S${i}`));
    expect(p).toMatch(/up to 6 BUYS THIS REBALANCE/);
    expect(p).toMatch(/per-window allowance, not a target holding count/);
  });

  test("it states the DILUTION, which is the part that matters", () => {
    // 12 main names means each position is ~50% of designed size. The count alone is abstract;
    // the size consequence is the thing that explains an index-clone book.
    const line = countLine(Array.from({ length: 12 }, (_, i) => `S${i}`));
    expect(line).toMatch(/roughly 50% of the size/);
  });

  test("it points at BUYING FEWER, never at freeing a slot", () => {
    // The original wording invited the free-a-slot judgment — the prompt's ONE authorised
    // discretionary exit. Under T+1 a slot-freeing sell cannot fund a buy the same day, so it is
    // guaranteed unpaired: the book ends in cash with nothing bought. Say the constraint out loud.
    const line = countLine(Array.from({ length: 12 }, (_, i) => `S${i}`));
    expect(line).toMatch(/BUY FEWER, LARGER names/);
    expect(line).toMatch(/T\+1 a sell does not fund a buy today/);
    expect(line).not.toMatch(/free-a-slot|free a slot/);
    expect(line).toMatch(/NOT an instruction to sell/);
  });

  test("OFF the rebalance window the note is silent — pressure with no outlet", () => {
    // Off-window, main buys are CLOSED and rotation sells are forbidden. An over-target nudge there
    // can only be acted on by reframing a rotation as a loss-discipline exit.
    const over = Array.from({ length: 12 }, (_, i) => `S${i}`);
    expect(countLine(over, [], false)).toContain("12 held");
    expect(countLine(over, [], false)).not.toContain("OVER target");
    expect(countLine(over, [], true)).toContain("OVER target");
  });

  test("one over target is NOT flagged — '~6' is a soft number", () => {
    // Firing at 7 would invite a rotation whose whole benefit is 86% -> 100% of designed size.
    expect(countLine(Array.from({ length: 7 }, (_, i) => `S${i}`))).not.toContain("OVER target");
    expect(countLine(Array.from({ length: 8 }, (_, i) => `S${i}`))).toContain("2 OVER target");
  });

  test("an empty book does not render a spurious over-target warning", () => {
    expect(countLine([])).not.toContain("OVER target");
  });
});
