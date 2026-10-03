# CI secrets — what each workflow needs, and the one gap

Audited 2026-10-03.

## RESOLVED 2026-10-03 — both added, escapes removed

## The gap was exactly two secrets

`PERSONAL_ACCOUNT_ID` and `AGENTIC_ACCOUNT_ID` were not GitHub Actions secrets, which is why all
three workflows that run `check:secrets` declared `ALLOW_NO_ACCOUNT_IDS: "1"` — the scanner's
strongest check (exact match against the real account numbers) was off in CI, by declaration rather
than silently. Both are now set and all three escapes are gone; CI runs the same check as a local
`bun run check:secrets`.

The scanner is also now PER-ID rather than all-or-nothing: it value-checks whichever ids it has and
names them in its success line. That matters if `PERSONAL_ACCOUNT_ID` is ever withdrawn — nothing
but this script reads it, so keeping a personal identifier in CI is a real cost — because the
agentic check would keep running instead of the whole mode collapsing to generic patterns.

Everything else is INFERRED to be configured from behaviour, not confirmed by listing (no `gh` on this
machine to check):
`autopilot.yml` runs on schedule, `deploy-on-merge.yml` deploys, and `backtest.yml` runs — none of
which would work with a missing secret.

| secret | used by | status |
|---|---|---|
| `AGENTIC_ACCOUNT_ID` | the 3 `check:secrets` callers | set 2026-10-03 |
| `PERSONAL_ACCOUNT_ID` | the 3 `check:secrets` callers | set 2026-10-03 |
| `ANTHROPIC_API_KEY` | `autopilot.yml` | set |
| `CRON_SECRET` | `autopilot.yml`, `cron.yml`, `probe-mcp-schema.yml` | set |
| `RESEND_API_KEY`, `ALERT_EMAIL` | `autopilot.yml` | set |
| `AUTOPILOT_PAT` | `autopilot.yml`, `autopilot-automerge.yml` | set |
| `SHARADAR_API_KEY` | `backtest.yml` | set |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | `deploy-on-merge.yml` | set |

## Adding the two

`gh` is not installed on this machine (checked: not on PATH, not in Homebrew or /usr/local), so
either install it or use the web UI.

**Web UI:** repo → Settings → Secrets and variables → Actions → New repository secret. Add
`AGENTIC_ACCOUNT_ID` and `PERSONAL_ACCOUNT_ID`, copying each value from `.env.local`.

**Or with `gh`** (`brew install gh && gh auth login` first). These read straight from `.env.local`,
so the values are never typed and never echoed:

```bash
cd ~/Desktop/robinhood-agent
gh secret set AGENTIC_ACCOUNT_ID  --body "$(grep -E '^AGENTIC_ACCOUNT_ID='  .env.local | cut -d= -f2- | tr -d '\"\r')"
gh secret set PERSONAL_ACCOUNT_ID --body "$(grep -E '^PERSONAL_ACCOUNT_ID=' .env.local | cut -d= -f2- | tr -d '\"\r')"
gh secret list | grep ACCOUNT_ID    # confirm both appear
```

Note `.env.local`'s values have not been confirmed current against the Robinhood app — see the
open item in memory. A stale value here would make CI value-check against a number you no longer
use, which is a false green rather than a failure.

## Then remove the escape

Once both secrets exist, each of the three workflows should pass them through and drop the opt-out,
so CI runs the same check as a local `bun run check:secrets`:

```yaml
      - name: Secret/PII scan (gate)
        env:
          AGENTIC_ACCOUNT_ID: ${{ secrets.AGENTIC_ACCOUNT_ID }}
          PERSONAL_ACCOUNT_ID: ${{ secrets.PERSONAL_ACCOUNT_ID }}
        run: bun run check:secrets
```

Files: `.github/workflows/deploy-on-merge.yml`, `autopilot.yml`, `autopilot-automerge.yml`.

Deliberately **not** applied yet: removing `ALLOW_NO_ACCOUNT_IDS` before the secrets exist would
make the gate fail closed and block every deploy and autopilot run — correct behaviour, wrong order.

## Running the heavy jobs in CI

`backtest.yml` already has `SHARADAR_API_KEY`, so the long jobs (full-period backtest, Sharadar
pulls, `close-reconstruct` over all history) can run there rather than on a laptop. Anything calling
a prod endpoint needs `CRON_SECRET`, which is also already set.
