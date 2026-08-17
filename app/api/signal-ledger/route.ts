import { requireCronAuth } from "@/lib/auth";
import { computeSignalAttribution } from "@/lib/signal-ledger";

export const maxDuration = 60;

// Per-signal attribution for main-book (and influencer) BUYS.
//   GET /api/signal-ledger → each logged buy's forward return + per-signal edge stats.
// Which signals (★INS, ⚡NEWS, ↑/↓FIRM, earnings record, influencer backing) have actually
// predicted, measured from our own trades. Forward-only, accumulates from the first buy logged.
export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;

  const today = new Date().toISOString().split("T")[0];
  const { picks, signals, baselineReturnPct } = await computeSignalAttribution(today);

  return Response.json({
    asOf: today,
    note:
      "Forward return of each BUY measured from its fill price, attributed to the signals present at buy time. 'vsBaselinePct' = a signal's picks' avg return minus the avg over ALL picks (positive = the signal beat the typical pick). Small, mixed-horizon samples early — a ranking hint, not proof; correlation ≠ causation.",
    buysLogged: picks.length,
    baselineReturnPct,
    signals,
    picks,
  });
}
