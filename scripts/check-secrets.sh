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

# Lines matching these are legitimate (env-var refs, CI secret refs, service
# placeholders) and are filtered out before a hit is reported.
ALLOWLIST='process\.env|os\.environ|import\.meta\.env|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|secrets\.[A-Z_]+|onboarding@resend\.dev|noreply@|example\.(com|org)|YOUR_|placeholder|<[A-Za-z_]+>|xxxx'

hits=0
report() { # <name> <extended-regex>
  local name="$1" pat="$2" out
  out=$(git grep -nIE "$pat" -- . "${EXCLUDES[@]}" 2>/dev/null | grep -vE "$ALLOWLIST")
  if [ -n "$out" ]; then
    printf '✗ %s\n' "$name"
    printf '%s\n\n' "$out" | sed 's/^/    /'
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
report "Hardcoded secret literal"   "(API_?KEY|APIKEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9/_+=.-]{16,}[\"']"

# ── Personal / account info ──────────────────────────────────────────────────
report "Personal email address"     '[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|live|icloud|aol|proton(mail)?)\.[a-z]{2,}'
report "Account number literal"      '[Aa]ccount[^A-Za-z0-9]{0,16}(number|num|id|#)?[^A-Za-z0-9]{0,4}[0-9]{8,}'

# Exact account IDs — only checked when exported (never committed to this file).
[ -n "${PERSONAL_ACCOUNT_ID:-}" ] && report "Personal account ID (\$PERSONAL_ACCOUNT_ID)" "${PERSONAL_ACCOUNT_ID}"
[ -n "${AGENTIC_ACCOUNT_ID:-}" ]  && report "Agentic account ID (\$AGENTIC_ACCOUNT_ID)"   "${AGENTIC_ACCOUNT_ID}"

if [ "$hits" -ne 0 ]; then
  echo "❌ check-secrets: potential secret or personal info in tracked files (see above)."
  echo "   Remove it (env-var it), or if it's a false positive refine scripts/check-secrets.sh."
  exit 1
fi
echo "✅ check-secrets: no secrets or personal info detected in tracked files."
exit 0
