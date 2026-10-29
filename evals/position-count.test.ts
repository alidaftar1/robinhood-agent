import { describe, test, expect } from "bun:test";
import { buildV1AnalysisPrompt } from "@/lib/strategy";
import { TARGET_MAIN_POSITIONS } from "@/lib/position-target";

// The prompt already argued for concentration ("a concentrated ~6-name book beats a long thin
// tail") but never showed whether the book COMPLIED — it listed holdings and never counted them.
// So the model had no way to know it was holding 12 against a 6-name design, which is how the
// count ratcheted to $201 positions against a ~$402 target. This surfaces the missing input.
const pos = (symbol: string) => ({ symbol, quantity: "1", avgCost: "100", price: 101, heldDays: 5 });
/** N distinct symbols — derived from the target so these tests survive the next change to it.
 *  They hardcoded 6 until 2026-10-14 and ten of them broke on 6 -> 7. */
const nNames = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);
const AT_CAP = nNames(TARGET_MAIN_POSITIONS);
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
    expect(line).toContain(`${11 - TARGET_MAIN_POSITIONS} OVER target`);
  });

  test("influencer holdings are EXCLUDED — the sleeve has its own 2-slot cap", () => {
    // Counting them would overstate the main book and could push the model to sell a main name to
    // fix a number the sleeve owns.
    expect(countLine(["A", "B", "C"], ["A", "B"])).toContain("1 held");
  });

  test("at or under target it says so without a lecture", () => {
    const line = countLine(AT_CAP);
    expect(line).toContain(`${TARGET_MAIN_POSITIONS} held`);
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
    const line = countLine(nNames(12));
    expect(line).toMatch(new RegExp(`roughly ${Math.round(TARGET_MAIN_POSITIONS / 12 * 100)}% of the size`));
  });

  test("it points at BUYING FEWER, never at freeing a slot", () => {
    // The original wording invited the free-a-slot judgment — the prompt's ONE authorised
    // discretionary exit. Selling a holding just to make room is churn, so the note sends that to the
    // hysteresis rule instead. (The old reason — T+1 left the exit unpaired — ended with limited
    // margin on 2026-10-24; the note must not still assert it.)
    const line = countLine(nNames(12));
    expect(line).toMatch(/BUY FEWER, LARGER names/);
    expect(line).toMatch(/governed by the hysteresis rule/);
    expect(line).not.toMatch(/T\+1/);
    expect(line).not.toMatch(/free-a-slot|free a slot/);
    expect(line).toMatch(/NOT an instruction to sell/);
  });

  test("OFF the rebalance window the note is silent — pressure with no outlet", () => {
    // Off-window, main buys are CLOSED and rotation sells are forbidden. An over-target nudge there
    // can only be acted on by reframing a rotation as a loss-discipline exit.
    const over = nNames(12);
    expect(countLine(over, [], false)).toContain("12 held");
    expect(countLine(over, [], false)).not.toContain("OVER target");
    expect(countLine(over, [], true)).toContain("OVER target");
  });

  test("one over target is NOT flagged — '~6' is a soft number", () => {
    // Firing at 7 would invite a rotation whose whole benefit is 86% -> 100% of designed size.
    expect(countLine(nNames(TARGET_MAIN_POSITIONS + 1))).not.toContain("OVER target");
    expect(countLine(nNames(TARGET_MAIN_POSITIONS + 2))).toContain("2 OVER target");
  });

  test("at the cap it states ZERO new names, because the code enforces 6 absolutely", () => {
    // 2026-10-13: the line said "6 held vs a target of ~6" and nothing else, so the model read a
    // satisfied SOFT target and decided a 7th and 8th name ("the target is approximate"), both
    // dropped by the cap. Seven such buys died this way across four of seven sessions while settled
    // cash sat idle. The "~" governs what the book may SIT at, never what may be BOUGHT.
    const line = countLine(AT_CAP);
    expect(line).toContain("NEW MAIN NAMES YOU CAN ADD TODAY: 0");
    expect(line).toMatch(/NOT soft/);
    expect(line).toMatch(/DROPPED before orders are placed/);
  });

  test("it names the one main-book buy that still executes at the cap: a TOP-UP", () => {
    // app/api/trade exempts a top-up from the slot count on purpose, and the prompt never said so —
    // leaving the model with no stated way to deploy settled cash at the cap.
    const line = countLine(AT_CAP);
    expect(line).toMatch(/TOP-UP of a name you already hold does not consume a slot/);
    expect(line).toMatch(/per-position dollar cap/);
  });

  test("the slot count does NOT reintroduce the free-a-slot nudge", () => {
    // Same invariant as the over-target note above, on the new sentence: naming it invites selling a
    // holding just to make room. Checked at the cap AND over it, the two states that would tempt it.
    for (const n of [TARGET_MAIN_POSITIONS, TARGET_MAIN_POSITIONS + 1, 12]) {
      const line = countLine(Array.from({ length: n }, (_, i) => `S${i}`));
      expect(line).not.toMatch(/free-a-slot|frees? a slot/);
      expect(line).toMatch(/NOT an instruction to sell/);
    }
  });

  test("BELOW the cap it states the real allowance, not zero", () => {
    // The control: if this said 0 everywhere the book could never be rebuilt after exits.
    expect(countLine(nNames(4))).toContain(`NEW MAIN NAMES YOU CAN ADD TODAY: ${TARGET_MAIN_POSITIONS - 4}`);
    expect(countLine([])).toContain(`NEW MAIN NAMES YOU CAN ADD TODAY: ${TARGET_MAIN_POSITIONS}`);
    expect(countLine(nNames(4))).not.toMatch(/NOT soft/);
  });

  test("OFF-window the slot count shows but the top-up guidance does not", () => {
    // Main buys are CLOSED off-window, so pointing at a top-up there contradicts the cadence gate.
    const line = countLine(nNames(4), [], false);
    expect(line).toContain(`NEW MAIN NAMES YOU COULD ADD: ${TARGET_MAIN_POSITIONS - 4}`);
    expect(line).toMatch(/main-book buys are CLOSED today/);
    expect(line).not.toMatch(/TOP-UP/);
  });

  test("an influencer holding does not consume a main slot in the stated count", () => {
    // Same exclusion the cap itself applies; stating otherwise would tell the model it is full when
    // it has room.
    // 2 of the held names are sleeve, so main holds N-2 and has 2 slots left.
    const held = nNames(TARGET_MAIN_POSITIONS);
    const sleeve = held.slice(-2);
    expect(countLine(held, sleeve)).toContain("NEW MAIN NAMES YOU CAN ADD TODAY: 2");
  });

  test("an empty book does not render a spurious over-target warning", () => {
    expect(countLine([])).not.toContain("OVER target");
  });
});
