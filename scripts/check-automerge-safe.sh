#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-automerge-safe.sh — the DETERMINISTIC gate for autopilot auto-merge.
#
# Exit 0 (AUTO-SAFE) ONLY if EVERY changed file (git diff BASE..HEAD) is in the
# trading-neutral allowlist below — files where a change provably CANNOT:
#   (a) place or alter a trade,           (b) weaken a deploy/CI gate (evals),
#   (c) edit the agent's own instructions (CLAUDE.md / .github prompts).
# DEFAULT-DENY: any file outside the allowlist → exit 1 (needs a human).
#
# This is the FLOOR. The cloud agent's `autopilot:auto-safe` label is a SECOND,
# independent condition (checked in the workflow) — the LLM can only make the
# decision MORE conservative (escalate to needs-human), never override this gate.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="${1:?usage: check-automerge-safe.sh <base-sha> <head-sha>}"
HEAD="${2:?usage: check-automerge-safe.sh <base-sha> <head-sha>}"

# A change to any of these cannot affect trading, cannot weaken a deploy gate, and
# is not the agent's own instructions. Deliberately conservative — widen only with care.
is_safe() {
  case "$1" in
    lib/autopilot-known-issues.ts) return 0 ;;  # reviewer's past-misses registry (can only ADD caution)
    lib/autopilot-review.ts)       return 0 ;;  # the skeptical reviewer (read-only vs trading)
    lib/dashboard-reconcile.ts)    return 0 ;;  # read-only audit that REPORTS, never acts
    lib/braintrust-trace.ts)       return 0 ;;  # telemetry / trace logging
    app/dashboard-view.tsx)        return 0 ;;  # dashboard UI (display only)
    docs/*)                        return 0 ;;  # documentation
    *)                             return 1 ;;  # everything else → human (default-deny)
  esac
}
# NOT allowlisted on purpose: all trading/data/signal code (strategy, market-data,
# buy-sizing, influencer-signals, news, earnings, run-store, risk-metrics, every
# app/api/*/route.ts), evals/** (they GATE deploys — never auto-weaken them), and
# CLAUDE.md / .github/** (the agent's own instructions + this very workflow).

files="$(git diff --name-only "$BASE".."$HEAD")"
if [ -z "$files" ]; then echo "REJECT — no changed files detected"; exit 1; fi

unsafe=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  is_safe "$f" || unsafe="$unsafe
  $f"
done <<< "$files"

if [ -n "$unsafe" ]; then
  echo "NOT-AUTO-SAFE — diff touches non-allowlisted file(s), needs a human:$unsafe"
  exit 1
fi

echo "AUTO-SAFE — every changed file is trading-neutral (allowlisted):"
echo "$files" | sed 's/^/  ✓ /'
exit 0
