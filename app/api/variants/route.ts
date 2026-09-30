import { requireCronAuth } from "@/lib/auth";
import { replayAllVariants, REPLAY_WINDOW_DAYS } from "@/lib/variant-replay";
import { VARIANTS, BASELINE_VARIANT_ID } from "@/lib/strategy-variant";

export const maxDuration = 60;

// TIER 0 of the strategy-research agent (docs/scope-strategy-research-agent.md).
//   GET /api/variants → every registered variant replayed over the stored feature capture.
//
// READ-ONLY and WRITE-FREE by construction: variants are pure functions over already-captured
// features, and their picks are recomputed on read. Nothing here places an order, stores a pick,
// or touches the return accounting — the optimizer must never control the scorer.
//
// Results are split IN-SAMPLE vs OUT-OF-SAMPLE against each variant's registeredAt and are never
// merged: because picks are recomputed on read, a variant written today can be replayed over days
// that already happened, which is exactly the look-ahead that makes backtests lie.
export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const today = new Date().toISOString().split("T")[0];
  const result = await replayAllVariants(VARIANTS, today, REPLAY_WINDOW_DAYS);

  return Response.json({
    asOf: today,
    note:
      "Tier 0: zero-capital strategy variants replayed over the stored point-in-time feature capture. " +
      "IN-SAMPLE days predate a variant's registeredAt (it was written knowing them) and can only ever " +
      "DISQUALIFY — never promote. OUT-OF-SAMPLE days are genuine forward evidence and are the only basis " +
      "for the promotion verdict. Scored one vote per NAME against SPY over each pick's own window. " +
      "Forward evidence kills a bad variant fast and confirms a good one slowly (IR 0.5 needs ~16 years " +
      "at 95% confidence), so an 'eligible' verdict is a TIER 1 CANDIDATE, not a validated strategy.",
    baselineVariantId: BASELINE_VARIANT_ID,
    ...result,
  });
}
