#!/bin/bash
# Daily autopilot check — runs at 8:30am PT Mon–Fri via launchd
# See README.md for setup instructions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

LOG_DIR="$HOME/robinhood-autopilot-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y%m%d).log"

echo "" >> "$LOG_FILE"
echo "=== Robinhood Autopilot $(date) ===" >> "$LOG_FILE"

cd "$PROJECT_DIR"

# Load project env vars (gives Claude access to API keys, secrets, and account IDs)
set -a; source .env.local 2>/dev/null || true; set +a

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

# Pass live credentials in the prompt so Claude doesn't have to guess placeholder values.
# CLAUDE.md has the full protocol — this prompt just surfaces the runtime context.
claude --print \
  "Run the full daily autopilot check as defined in CLAUDE.md.

Runtime context (from .env.local):
  APP_URL=${APP_URL}
  CRON_SECRET=${CRON_SECRET}
  AGENTIC_ACCOUNT_ID=${AGENTIC_ACCOUNT_ID}
  ALERT_EMAIL=${ALERT_EMAIL}

API base:  ${APP_URL}
Auth header: Authorization: Bearer ${CRON_SECRET}

Follow every step in CLAUDE.md in order, including the live Robinhood position verification. Fix any issues found before sending the email." \
  2>&1 | tee -a "$LOG_FILE"

echo "=== Done $(date) ===" >> "$LOG_FILE"
