#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-secrets.sh — deterministic secret / personal-info scanner.
#
# Greps every git-TRACKED file for credential- and PII-shaped strings so a leak
# can't slip into the shared repo or a prod deploy. Deterministic on purpose: a
# grep gate can't "forget" the way an LLM reviewer can.
#
# Exit 0 = clean.  Exit 1 = potential leak (offending lines printed).  Exit 2 = not a git repo.
#
# Wired into:
#   - .claude/settings.json   — PreToolUse gate blocks `git push` / prod deploy on a hit
#   - .github/autopilot-prompt.md — cloud autopilot runs it before any commit/deploy
#   - run manually any time:   bun run check:secrets
#
# NOTE: this file never hardcodes a real secret/account number (that would just
# re-commit it). Exact account IDs are matched only when exported in the env
# ($PERSONAL_ACCOUNT_ID / $AGENTIC_ACCOUNT_ID); otherwise the generic patterns
# below catch credential- and account-shaped literals by structure.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || {
  echo "check-secrets: not inside a git repo" >&2
  exit 2
}

# Files we never scan: the scanner itself (it defines the patterns) and lockfiles.
EXCLUDES=(
  ":(exclude)scripts/check-secrets.sh"
  ":(exclude)bun.lock"
  ":(exclude)package-lock.json"
  ":(exclude)*.lockb"
)

# Text matching these is legitimate (env-var refs, CI secret refs, service
# placeholders) and doesn't count as a hit on its own.
ALLOWLIST='process\.env|os\.environ|import\.meta\.env|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|secrets\.[A-Z_]+|onboarding@resend\.dev|noreply@|example\.(com|org)|YOUR_|placeholder|<[A-Za-z_]+>|xxxx'

hits=0
report() { # <name> <extended-regex>
  local name="$1" pat="$2" matches out=""
  # -o: the MATCHED SPAN only, not the whole line. Testing ALLOWLIST against the whole
  # line (as this used to) drops a real hardcoded fallback secret whenever the same line
  # also happens to mention process.env/$VAR elsewhere — exactly the fail-open shape this
  # scanner exists to catch (`TOKEN = process.env.TOKEN || "hardcoded-fallback-literal"`).
  # Testing only the matched span means an unrelated env-var reference on the same line
  # can no longer mask a real literal.
  matches=$(git grep -nIoE "$pat" -- . "${EXCLUDES[@]}" 2>/dev/null)
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    local filepath="${m%%:*}" rest="${m#*:}"
    local linenum="${rest%%:*}" span="${rest#*:}"
    # Narrow carve-out: `process.env.NAME = "literal"` (test/setup code WRITING a value INTO
    # process.env — e.g. evals/dashboard-auth.test.ts's fixtures) is not a leak; it's the
    # opposite shape from the dangerous `NAME = process.env.NAME || "literal"` READ-with-
    # fallback idiom this pattern exists to catch. Distinguish by requiring the SAME variable
    # name immediately fused to "process.env." with a plain "=" on the full source line — not
    # just "process.env appears somewhere on this line" (that blanket version is the exact
    # masking bug this rewrite fixes elsewhere).
    local varname
    varname=$(printf '%s' "$span" | grep -oE '^[A-Za-z0-9_]+')
    local fullline=""
    [ -n "$varname" ] && fullline=$(sed -n "${linenum}p" "$filepath" 2>/dev/null)
    if printf '%s' "$fullline" | grep -qE "process\\.env\\.${varname}[[:space:]]*=[[:space:]]*[\"']"; then
      continue
    fi
    if ! printf '%s' "$span" | grep -qE "$ALLOWLIST"; then
      out="${out}${m}"$'\n'
    fi
  done <<< "$matches"
  if [ -n "$out" ]; then
    printf '✗ %s\n' "$name"
    printf '%s\n' "$out" | sed 's/^/    /'
    hits=1
  fi
}

# ── Credential-shaped strings ────────────────────────────────────────────────
report "Anthropic API key"          'sk-ant-[A-Za-z0-9_-]{16,}'
report "OpenAI-style key"           'sk-[A-Za-z0-9]{32,}'
report "GitHub token"               '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,})'
report "AWS access key id"          'AKIA[0-9A-Z]{16}'
report "URL with embedded creds"    'https?://[A-Za-z0-9._~%-]+:[^@/[:space:]"]+@'
report "Redis/DB URL with auth"     '(rediss?|postgres(ql)?|mongodb(\+srv)?)://[^@[:space:]"]*:[^@[:space:]"]+@'
report "Resend API key"             're_[A-Za-z0-9_]{16,}'
# Vercel tokens are opaque random strings with no distinguishing prefix/shape to pattern-
# match by value — "Hardcoded secret literal" below already catches a hardcoded VERCEL_TOKEN
# by variable name (the *_TOKEN suffix), which is the only reliable signal available for it.
# Operator alternation includes ||/?? (not just :/=) so this also catches the classic
# fail-open fallback idiom itself — `process.env.SECRET || "hardcoded-literal"` — not just
# a bare `SECRET = "literal"` assignment. Before this, that idiom wasn't matched at all,
# regardless of the allowlist: the old :/= -only version never even reached the literal.
report "Hardcoded secret literal"   "([A-Za-z0-9]+_)?(SECRET|TOKEN|KEY|PASSWORD|APIKEY)[\"']?[[:space:]]*(:|=|\\|\\||\\?\\?)[[:space:]]*[\"'][A-Za-z0-9/_+=.-]{16,}[\"']"

# ── Personal / account info ──────────────────────────────────────────────────
report "Personal email address"     '[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|live|icloud|aol|proton(mail)?)\.[a-z]{2,}'
# "account" (any casing, singular/plural) followed within ~24 non-digit chars by an 8+ digit
# run. Broadened 2026-08-21: the old pattern required the digits to sit within 4 chars of an
# optional "number/num/id/#" token, so `Account numbers (670284256, ...)` — the plural word plus
# the " (" before the digits — slipped straight through and reached the public repo.
report "Account number literal"      '[Aa]ccount[sS]?[^0-9]{0,24}[0-9]{8,}'

# Exact account IDs — only matched by VALUE when the env vars are present (they are never
# committed to this file). When they're absent the check above is the only account-number
# defense, so say so LOUDLY: a silent skip here is exactly what let two account numbers reach
# the public repo (2026-08-21) — a green scan must never be mistaken for "IDs verified".
if [ -z "${PERSONAL_ACCOUNT_ID:-}" ] || [ -z "${AGENTIC_ACCOUNT_ID:-}" ]; then
  MISSING=""
  [ -z "${PERSONAL_ACCOUNT_ID:-}" ] && MISSING="PERSONAL_ACCOUNT_ID"
  [ -z "${AGENTIC_ACCOUNT_ID:-}" ]  && MISSING="${MISSING:+$MISSING, }AGENTIC_ACCOUNT_ID"
  echo "⚠️  check-secrets: exact account-ID matching DISABLED for: ${MISSING}."
  echo "    Relying on the generic 'Account number literal' pattern only. Export the real ID(s)"
  echo "    (env or .env.local) to also match your account numbers by exact value."
fi
[ -n "${PERSONAL_ACCOUNT_ID:-}" ] && report "Personal account ID (\$PERSONAL_ACCOUNT_ID)" "${PERSONAL_ACCOUNT_ID}"
[ -n "${AGENTIC_ACCOUNT_ID:-}" ]  && report "Agentic account ID (\$AGENTIC_ACCOUNT_ID)"   "${AGENTIC_ACCOUNT_ID}"

if [ "$hits" -ne 0 ]; then
  echo "❌ check-secrets: potential secret or personal info in tracked files (see above)."
  echo "   Remove it (env-var it), or if it's a false positive refine scripts/check-secrets.sh."
  exit 1
fi
echo "✅ check-secrets: no secrets or personal info detected in tracked files."
exit 0
