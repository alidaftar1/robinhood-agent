# Robinhood Agent

An autonomous equity trading agent built with Claude AI and the Robinhood MCP server. Runs daily on Vercel, rebalances a real portfolio, and emails a summary report — no human required.

> ⚠️ **Disclaimer — not financial advice.** This is a personal, experimental engineering project built for **educational and portfolio purposes only**. It is **not financial, investment, or trading advice**, and nothing here is a recommendation to buy or sell any security. The author is **not a licensed financial advisor**. Autonomous trading carries real risk: this software trades a real brokerage account and **can and does lose money**; past performance does not indicate future results. The software is provided **"as is," without warranty of any kind**, and the author accepts **no liability** for any loss or damage arising from its use. It is **not affiliated with, endorsed by, or sponsored by** Robinhood, Anthropic, or any other company named here. **Use at your own risk.**

## How it works

Every weekday at 7:30am PT, a Vercel cron fires `/api/trade`:

**Session 1 — Sonnet analysis (no MCP)**
Fetches market data (price momentum, insider buys, analyst ratings, earnings calendar), then calls Claude Sonnet to reason about the portfolio and output a structured trade decision:
```
TRADE_DECISION:{"thesis":"...","sells":[...],"buys":[...]}
```

**Session 2 — Haiku sell execution (MCP)**
Claude Haiku places all sell orders via the Robinhood MCP tool, sequentially.

**Session 3 — Haiku buy execution (MCP)**
Claude Haiku places all buy orders, one at a time, using only settled cash (T+1 compliance).

**Session 4 — Haiku verification (MCP)**
Calls `get_equity_orders` to confirm every order actually exists in Robinhood. Replaces unconfirmed placeholders with real fill prices. Sends an alert if any order is missing.

The run is saved to Upstash Redis and surfaced on a dashboard.

### Additional crons

All crons are scheduled via **Vercel** (`vercel.json`), which sends `Authorization: Bearer $CRON_SECRET` automatically. Requires Vercel Pro (the Hobby plan silently caps at 2 active cron jobs).

| Time (PT) | Endpoint | Purpose |
|---|---|---|
| 6:30am | `/api/insider` | Refresh EDGAR insider buy cache |
| 7:30am | `/api/trade` | Daily rebalance |
| 8:00am | `/api/autopilot` | Monitoring email + self-heal |
| 10:00am | `/api/drop-check` | Stop-loss: exit any position down ≥5% intraday |
| 12:00pm | `/api/earnings-exit` | Exit positions with earnings within 2 days |

`.github/workflows/cron.yml` is kept as a manual fallback (`workflow_dispatch`) for triggering individual endpoints on demand.

### Signal stack

The agent ranks stocks by a composite momentum score:

```
rank = sharpe5d × 0.6 + sharpe14d × 0.4
```

- **sharpe5d** — 5-day return / annualized volatility (primary: what's moving *now*)
- **sharpe14d** — 14-day return / annualized volatility (confirmation: sustained trend vs spike)
- **α (alpha)** — return vs SPY over the same window
- **Insider buys** — recent EDGAR Form 4 filings by officers/directors
- **Analyst upgrades** — recent rating changes with price targets

### Safety rails

- **T+1 settlement**: buys only use settled cash, never same-day sell proceeds
- **Position cap**: no single buy exceeds 40% of total portfolio value
- **Earnings blackout**: exits all positions before imminent earnings (≤2 days)
- **Stop-loss**: intraday drop ≥5% triggers an immediate sell
- **Minimum buy**: $50 floor — no fractional deploys
- **Universe**: S&P 500 stocks only

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Next.js 15 (App Router), TypeScript |
| Deploy | Vercel (crons, serverless functions) |
| AI | Claude Sonnet 4 (analysis), Claude Haiku 4 (execution) |
| Brokerage | Robinhood MCP server |
| Storage | Upstash Redis |
| Alerts | Resend |
| Market data | Financial Modeling Prep API |
| Insider data | SEC EDGAR |

---

## Eval suite

12 scenarios, 25+ structural checks covering the full decision space. Run with:

```bash
bun --env-file=.env.local test evals/eval.test.ts
```

| Scenario | What it tests |
|---|---|
| `empty-portfolio` | Builds a new portfolio from cash |
| `rebalance-losers` | Rotates out laggards, keeps winners |
| `no-buying-power` | Holds or sells to rebalance, no overspend |
| `overweight-single-position` | Respects 40% position cap |
| `bear-market` | Conservative / cash-preservation behavior |
| `imminent-earnings` | Does not buy into earnings |
| `t1-settlement` | Buys only within settled cash |
| `min-position-size` | No buys when cash < $50 |
| `analyst-upgrade` | Acknowledges and weights upgrade signal |
| `earnings-exit` | Exits held positions before earnings |
| `drop-check` | Sells positions down ≥5% intraday |
| `insider-signal` | Acknowledges and weights insider buy signal |

Each scenario runs 10 structural checks (sell-before-buy ordering, position caps, T+1 compliance, earnings avoidance, etc.) plus an LLM-graded reasoning quality check.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/alidaftar1/robinhood-agent
cd robinhood-agent
bun install
```

### 2. Environment variables

Create `.env.local`:

```bash
ANTHROPIC_API_KEY=           # Claude API key
UPSTASH_REDIS_REST_URL=      # Upstash Redis URL
UPSTASH_REDIS_REST_TOKEN=    # Upstash Redis token
CRON_SECRET=                 # Secret for protecting cron + dashboard endpoints
RESEND_API_KEY=              # Resend API key for email reports
FMP_API_KEY=                 # Financial Modeling Prep (market data + insider)
APP_URL=                     # Your deployed Vercel URL (e.g. https://your-app.vercel.app)
ALERT_EMAIL=                 # Email address for daily reports and alerts
AGENTIC_ACCOUNT_ID=          # Robinhood account ID the agent trades
PERSONAL_ACCOUNT_ID=         # Robinhood account ID for read-only comparison (optional)
```

### 3. Robinhood MCP

The agent uses the [Robinhood MCP server](https://github.com/brokerage-mcp/robinhood-mcp) for order execution. Configure it in your Claude Code MCP settings and authenticate before the first run.

### 4. Deploy to Vercel

```bash
vercel --prod
```

Set all environment variables in the Vercel dashboard (or `vercel env add`).

### 5. Update CLAUDE.md

Fill in your account IDs, email, and budget cap in `CLAUDE.md` — this file drives the local autopilot agent.

### 6. Local autopilot (optional)

To run the daily monitoring check locally via macOS launchd:

```bash
# Make the script executable
chmod +x scripts/autopilot.sh

# Create a LaunchAgent plist that runs it at 8am weekdays
# Edit the plist to point to your project path, then:
launchctl load ~/Library/LaunchAgents/com.yourname.robinhood-autopilot.plist
```

The script sources `.env.local` and calls `claude --print` with the autopilot instructions from `CLAUDE.md`.

---

## Key files

```
app/api/trade/route.ts          — Four-session daily rebalance cron
app/api/autopilot/route.ts      — Monitoring cron + self-heal
app/api/drop-check/route.ts     — Intraday stop-loss
app/api/earnings-exit/route.ts  — Pre-earnings exit
app/api/runs/route.ts           — Dashboard data API
app/page.tsx                    — Run history dashboard
lib/strategy.ts                 — System prompt + analysis prompt
lib/market-data.ts              — Price data, momentum signals, formatting
lib/run-store.ts                — Redis read/write helpers
lib/insider.ts                  — EDGAR insider buy fetching
lib/analyst.ts                  — Analyst rating fetching
evals/eval.test.ts              — Full eval suite (12 scenarios, 25+ checks)
evals/fixtures.ts               — Market data fixtures + scenario definitions
evals/checks.ts                 — Structural assertion library
scripts/autopilot.sh            — Local autopilot shell script
CLAUDE.md                       — Autopilot guardrails for Claude Code
```

---

## Architecture notes

**Why three AI sessions instead of one?**
A single long-running Claude + MCP session hit Vercel's function timeout. Splitting into analysis (Sonnet, no tools) → sell execution (Haiku + MCP) → buy execution (Haiku + MCP) keeps each session well under the limit and lets us use the right model for each task.

**Why Haiku for execution?**
Execution sessions are tool-calling loops with no complex reasoning. Haiku is faster and cheaper while being equally reliable for sequential `place_equity_order` calls.

**Why sequential buy orders?**
Placing all buys simultaneously caused the session to hit token limits mid-execution. Sequential ordering is slower but reliable.

**T+1 settlement**
Robinhood cash accounts (non-margin) require sell proceeds to settle before they can fund new buys. The agent tracks settled buying power separately and never uses same-day sell proceeds for buys.
