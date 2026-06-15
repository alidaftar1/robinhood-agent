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

# Load project env vars (gives Claude access to RESEND_API_KEY for email sending)
set -a; source .env.local 2>/dev/null || true; set +a

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

claude --print \
  "Run the daily autopilot check as defined in CLAUDE.md. Check today's trade run, fix any issues found, and send a summary email." \
  2>&1 | tee -a "$LOG_FILE"

echo "=== Done $(date) ===" >> "$LOG_FILE"
