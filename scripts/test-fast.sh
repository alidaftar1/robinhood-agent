#!/usr/bin/env bash
# FAST GATE — every deterministic eval, in seconds. Safe to block a deploy on.
#
# The split exists because the full suite takes ~55 minutes and is LLM-stochastic: three identical
# runs produced 3 / 3 / 1 failures, so a 1-3 test spread is its NOISE FLOOR. A gate that flickers
# is not a gate — it gets ignored, and then nothing gates.
#
# DEFINED BY EXCLUSION, on purpose. The previous split (`test:unit`) listed the 41 files to INCLUDE
# and had already drifted: exit-ledger and wiring were missing, so the newest tests — covering the
# newest code — silently ran in no gate at all. Listing what to SKIP means a new eval file is in the
# fast gate by default, and the only way out is to name it here with a reason.
set -euo pipefail
cd "$(dirname "$0")/.."

# Slow + non-deterministic: live model calls, graded by an LLM judge.
SKIP_LLM="eval.test.ts reviewer-recall.test.ts"
# Need a deployed app or a live third-party API; they test the ENVIRONMENT, not the code.
SKIP_NET="integration.test.ts"

FILES=()
for f in evals/*.test.ts; do
  b="$(basename "$f")"
  case " $SKIP_LLM $SKIP_NET " in *" $b "*) continue ;; esac
  FILES+=("$f")
done

echo "fast gate: ${#FILES[@]} files (skipping: $SKIP_LLM $SKIP_NET)"
exec bun test "${FILES[@]}" --timeout 20000
