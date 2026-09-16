/**
 * "ahead" / "behind" / "tied" for a stat shown next to its SPY comparison, decided at the
 * PRECISION SHOWN on the card.
 *
 * The original test was `ours >= theirs ? "ahead" : "behind"`, which called an exact TIE "ahead"
 * and could also claim an edge invisible in the rendered numbers (0.5034 vs 0.4996 both print
 * 0.50). If the two round to the same displayed figure, the honest word is "tied".
 *
 * Scope note: this compares only the two Sharpe LEVELS it is given. It is NOT a consistency
 * guarantee against the neighbouring "~N% beats SPY" stat — that comes from the Sharpe of daily
 * EXCESS returns (`sharpeProbPositive`), and ours-Sharpe > SPY-Sharpe does not imply excess-Sharpe
 * > 0. A real, visible gap can still legitimately render "0.62 (ahead) · ~45% beats SPY".
 */
export function vsSpyLabel(ours: number, theirs: number, digits = 2): "ahead" | "behind" | "tied" {
  // Normalize signed zero: (-0.004).toFixed(2) is "-0.00" but (0.004).toFixed(2) is "0.00", which
  // would otherwise render a directional claim off two numbers that are both zero as displayed.
  const shown = (x: number) => {
    const s = x.toFixed(digits);
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
  };
  if (shown(ours) === shown(theirs)) return "tied";
  return ours > theirs ? "ahead" : "behind";
}
