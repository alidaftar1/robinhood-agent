# Design & migration plan — fractional / dollar-notional orders

**Status:** proposed, not started. Gated on owner approval of the direction below.
**Trigger:** `place_equity_order` schema (verified live 2026-08-04) supports both a fractional
`quantity` ("Decimals allowed for market + regular_hours only") and a `dollar_amount` notional
("USD notional e.g. '400.00'. Only valid with type=market"). The "whole shares only" rule was
self-imposed, never an MCP limit. Both are gated to `type=market` + `regular_hours` — exactly our
cadence (7:30am PT buys = 10:30am ET; 10am PT drop-check = 1pm ET; both regular hours).

**This is a MECHANISM change, not a strategy change.** No sleeve sizing %, momentum weights,
sector/position caps (as %), or stop/TP thresholds change. What changes is *how an order is
expressed* (dollars, not whole shares). Keeping that boundary is the point — see [[feedback_scope]].

---

## 1. The problem it fixes (all documented friction on this account)

- **Idle-cash drag** — a $322 share can't be bought with $323 buying power (the 3% buffer eats it),
  so cash sits idle.
- **Dropped whole-share buys** — TSLA ×1 @ $405 stranded ~$405 (~17% of equity); GPN ~$302. These
  are indivisibility artifacts, not decisions.
- **Slot-count capped by share price** — the strategy runs N≈6 partly because ~$250/slot "can't buy
  whole shares of the higher-priced momentum leaders" (`docs/strategy-quality-momentum.md`).
- **`buy-sizing.ts` complexity** — priciest-per-share-first ordering, the `usableBuyBudget` cushion,
  and the drop-and-idle logic exist *only* to cope with indivisible shares.

---

## 2. Core design decision

**Buys → `dollar_amount` (notional). Sells → fractional `quantity`, resolved to the LIVE held
amount at execution time (not retyped by the LLM).**

Rationale:
- **Notional buys** remove the price→share computation entirely. The analysis already reasons in
  dollars (`maxPositionDollars`, the buying-power budget). "Deploy $250 into X" is exactly what it
  wants to say. Budget-fit collapses to a pure dollar sum (`Σ dollarAmount ≤ settled BP`) with **no
  indivisibility → no dropped-buy idle, no per-share ordering**.
- **Sells by live quantity** avoid the one new hazard fractional introduces: the LLM mistyping a
  fractional share count (e.g. "2.371") and over/under-selling. For the common case (stops,
  rotations, full exits) the executor reads the **live** held quantity from `get_equity_positions`
  and sells exactly that — a full, clean exit. For partial trims, an explicit **`fraction`** (e.g.
  `0.5`) or a **`dollar_amount`** sell, never a raw retyped share count.

Rejected alternative — *fractional quantity buys* (LLM emits a decimal share count): still needs
price at decision time, pushes rounding onto the model, and is messier than a dollar amount. Notional
is strictly simpler for buys.

### 2a. Fractional-eligibility criteria (VERIFIED — Robinhood official, 2026-08-04)

Source: Robinhood Support, "Fractional shares." A security is fractional-eligible iff:

- It's an **NMS stock or ETF listed on a national exchange (NYSE/Nasdaq)** — **OTC is excluded**.
- **Share price ≥ $1.**
- **Market capitalization > $25,000,000.**
- Order is a **market order during regular hours**; min order **$1** (or 0.000001 sh, value ≥ $1).
- Fractional shares are **not transferable** out of Robinhood (irrelevant — we buy/hold/sell in-app).

**Implication for the two books:**
- **Main book (S&P 500): 100% eligible.** The S&P 500's smallest constituent is ~$18B market cap
  (≫ $25M), all are >$1 NMS names — no eligibility risk whatsoever.
- **Influencer sleeve: partial exposure.** The excluded set — OTC, sub-$1, sub-$25M-cap micro-caps
  and fresh SPACs — is exactly the speculative-pick profile the sleeve can surface. Those names get
  the **whole-share fallback** (§3c) → same as today. The liquidity concern collapses into this:
  Robinhood's own eligibility filter removes the illiquid names, so "not fractional-eligible" and
  "too thin to fractionally internalize" are the same set, both handled by the fallback.
- **Not a NEW execution risk:** we already place **market orders** on these names (buy/sell sessions
  are `type=market, gfd`), and Robinhood **internalizes** the fractional remainder rather than
  hitting the lit book — so fractional adds no market-impact risk for eligible names, and ineligible
  ones behave exactly as they do now.
- **Our existing liquidity gate already guarantees eligibility for the buy set (VERIFIED in code).**
  `lib/influencer-signals.ts` `filterToTradeable` (applied at signal-build time, line ~416, BEFORE
  scoring) drops any influencer ticker that isn't either known-liquid (S&P 500 ∪ curated
  `EXPANDED_UNIVERSE`) or validated live at **avg daily volume ≥ 1,000,000 shares AND price
  $5–$500**. That bar is *stricter* than Robinhood's fractional threshold (≥$5 vs ≥$1; ≥1M volume ⇒
  ≫$25M cap; Yahoo-resolvable ⇒ NMS). So in practice **every name the sleeve can buy is already
  fractional-eligible** — the whole-share fallback is a theoretical-edge-case safety-net, not a
  common path. (S&P 500 main book is likewise 100% eligible.) The fallback stays in for defense in
  depth, but no realistic pick should trigger it.

---

## 3. What changes, file by file

### 3a. Order-decision shape + prompts (`lib/strategy.ts`)
- `buildV1AnalysisPrompt` output line: buys become
  `{"symbol":"X","dollarAmount":250,"strategy":"main"}` (drop `quantity`; keep an optional `price`
  only as reasoning context, unused by the executor). Sells become
  `{"symbol":"X","exit":"all"}` for a full exit or `{"symbol":"X","fraction":0.5}` /
  `{"symbol":"X","dollarAmount":120}` for a trim.
- **Prompt text rewrites** (4 spots that currently say whole-shares / `floor(maxPos/price)`):
  `strategy.ts:180, 183, 242, 365`. New wording: "Size each buy as a **dollar amount**
  (`dollarAmount`), min $50, max `$maxPos` per position. Buys are notional — the broker fills
  fractional shares, so you never need to compute a share count and there is no whole-share
  remainder. `Σ dollarAmount` across buys ≤ settled buying power."
- `maxPositionDollars` (`strategy.ts:99`) is unchanged (already a dollar cap).

### 3b. Budget fit + cap guard (`lib/buy-sizing.ts`, `app/api/trade/route.ts`)
- `fitBuysToBudget` (`buy-sizing.ts:52–66`) — the `Math.floor(budget/unit)` + shrink/drop-whole-share
  logic is **retired**. Replace with a trivial notional fit: sort buys, take them in order until the
  running `Σ dollarAmount` would exceed the budget; the last one is **shrunk to the remaining
  dollars** (down to the $50 min, else dropped). No name is stranded by indivisibility.
- `positionCapQty` (`buy-sizing.ts:78`) — replace with `positionCapDollars(heldValue, maxPos)` =
  `max(0, maxPos − heldValue)`: cap a buy's `dollarAmount` to remaining room. No `Math.floor`, no
  force-sell (unchanged — trim only on the next buy).
- `usableBuyBudget` (`buy-sizing.ts:19`) — keep a **small** slippage buffer (market orders can fill a
  hair above quote), e.g. `bp * 0.99`, but the 2% whole-share price cushion is no longer needed.
- Trade-route cap-guard block (`route.ts:473–502`) and the `fitBuysToBudget` call (`:557–562`) adopt
  the dollar-based helpers; adjustment messages change "sh" → "$".

### 3c. Order execution (`app/api/trade/route.ts`, `drop-check`, `earnings-exit`)
- Buy session (`route.ts:664, 671`): instruction becomes
  `- buy $${b.dollarAmount} of ${b.symbol}` and the system prompt tells Haiku to call
  `place_equity_order` with **`type=market`, `dollar_amount=<N>`, `time_in_force=gfd`,
  `market_hours=regular_hours`** (no `quantity`).
- **Fractional-eligibility fallback (belt-and-suspenders):** if a notional order is **rejected as
  not fractional-eligible** (an OTC / sub-$1 / sub-$25M-cap name — see §2a), the executor **retries
  as a whole-share market order** sized `floor(dollarAmount / price)` (skip if that rounds to 0).
  Eligible names → exact-dollar fractional; ineligible names → **identical to today's behavior, no
  regression**. No pre-check needed — the broker's rejection is the signal. Log which path each buy
  took so we can see how often the fallback fires (mostly on the influencer sleeve).
- Sell session (`route.ts:576, 583`): for `exit:"all"` → instruct "sell the full held position of X"
  (Haiku reads live qty via MCP and sells `quantity=<live>`); for `fraction`/`dollarAmount` → pass
  the fraction (as `quantity = fraction × live`) or `dollar_amount`. Keep market/gfd/regular_hours.
- `earnings-exit` replacement buy (`earnings-exit.ts:88–92`) inherits the notional buy rules via the
  shared prompt — no separate whole-share text.
- Recorded fills (`route.ts:643, 730`) already store the broker's real (now possibly fractional)
  `quantity` string — **no change**.

### 3d. Accounting — CONFIRMED already fractional-safe (the big de-risk)
Verified: every value/return/concentration calc uses `parseFloat(quantity)` — `run-store.ts`
(`:447–482`, `findReRecordedSells :234–272`, `reconcilePositions :306–321`), `risk-metrics.ts`
(`:47,82,323,354,378`). **No change needed.** Two items to *review*, not rewrite:
- **Quantity string formatting** — the trade identity key (`run-store.ts:157`,
  `symbol|side|quantity|avgPrice`) and the `verify` 0.01 match tolerance (`verify:218,238`) depend on
  consistent qty formatting. Action: **normalize** every stored `quantity` to a fixed precision
  (e.g. `toFixed(6)`, trimmed) at the record boundary so `"2.37"` and `"2.370000"` can't diverge.
- **verify tolerance** — 0.01 shares is fine for whole shares; for fractional, keep 0.01 (still far
  below any real position) but confirm two same-name fractional fills can't false-match (they're
  summed by symbol before compare — safe).

### 3e. Scorer + evals
- `braintrust-trace.ts:44` — `scores.whole_shares` (`Number.isInteger`) is **removed/replaced** with a
  `notional_within_cap` score (each buy's `dollarAmount` ≤ `maxPositionDollars`, ≥ $50).
- `evals/checks.ts` — `checkWholeShares` (`:87–101`) and `checkDecisionWholeShares` (`:449–461`) plus
  their wiring (`:543, 567`) are **replaced** by a min-$50 / ≤-cap dollar check. Keep all
  buying-power / cash-conservation / position-cap checks (already fractional-safe arithmetic).
- `evals/eval.test.ts:583–642` — the three `fitBuysToBudget` whole-share tests + the `usableBuyBudget`
  test are **rewritten** for the notional fit (shrink-last-to-remaining-dollars, no indivisible drop).
- Add **fractional fixtures** (`evals/fixtures.ts`) — positions like `"2.371"` — to exercise the new
  path through returns/verify/reconcile.

### 3f. Dashboard + registry
- `dashboard-view.tsx:750, 764` — `parseFloat(quantity).toFixed(0)` **truncates** fractional shares.
  Change to a fractional-aware format (e.g. `toFixed(4)` trimmed, or `≥1 ? toFixed(2) : toFixed(4)`).
  Position/trade **values** already compute correctly (`:373, 395`).
- `autopilot-known-issues.ts:96` — the cap-guard entry describes `floor(maxPos/price)`; update its
  text to the dollar-based cap so the skeptical reviewer's mental model matches.

---

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Influencer pick not fractional-eligible** (OTC / <$1 / <$25M cap) → notional order rejected | **Automatic whole-share fallback** (§3c): retry `floor($/price)` market order = today's behavior. S&P 500 is 100% eligible (§2a), so this only ever touches speculative sleeve names — never worse than now. |
| Liquidity / market impact on thin influencer names | **Unchanged** — already market orders; Robinhood internalizes the fractional remainder (no lit-book hit). Smaller precise sizing arguably *reduces* impact vs. a forced 1-share clip. |
| LLM mistypes a fractional share count → over/under-sell | Sells never retype qty — executor resolves `exit:"all"` to the **live** held qty; trims use `fraction`/`dollar_amount`. |
| Float formatting drift breaks the trade identity key / re-recorded-sell dedup | Normalize stored `quantity` to fixed precision at the record boundary (§3d). |
| A notional buy slips above budget on a fast market | Keep a 1% slippage buffer in `usableBuyBudget`; `time_in_force=gfd` market order. |
| Off-hours execution | Notional/fractional is market+regular_hours only. Our crons are regular hours. **Constraint noted:** any future pre-market/after-hours stop must stay whole-share limit. |
| Partial-fill of a notional order | Broker returns the real filled qty+avg; we record that (already handled). |
| Fractional-share quirks (ACATS transfer, prorated dividends) | Irrelevant — we buy/hold/sell within Robinhood only. |
| T+1 settlement | Unchanged. |

---

## 5. Rollout (staged, live-money-safe)

1. **Build behind the isolated V1 path.** `buildV1AnalysisPrompt` is already separate from the legacy
   prompt (kept for rollback). Implement notional there + the helpers + evals.
2. **Green gate:** `bunx tsc` + `bun test evals/eval.test.ts` (rewritten). No new eval failures.
3. **Dry-run diff:** `GET /api/trade?dryRun=1&simulateCash=<N>` — confirm the decision emits
   `dollarAmount` buys, the notional fit deploys ~full cash (little/no idle), and the cap holds.
4. **Preview deploy** (not prod) → eyeball the dashboard renders fractional qty correctly.
5. **One controlled live validation:** on the next scheduled run, watch a single small notional buy
   fill and confirm it **records the fractional qty + avg correctly** and reconciles in `/api/verify`.
6. **Full cutover** after 4a–5 pass: `/code-review` → fix → `REVIEWED=1` prod deploy.
7. **Rollback:** revert the prompt/helpers to the whole-share version (isolated, one commit).

Suggested PR slicing (solo-dev, merge-to-main per [[feedback_git_workflow]]):
- PR1: helpers + prompt + decision shape + executor (the core).
- PR2: evals + scorer rewrite + fractional fixtures.
- PR3: dashboard display + registry text.

---

## 6. Open questions for the owner

1. **Partial trims** — support `fraction`/`dollar_amount` sells now, or ship **full-exit-only** first
   (simplest; trims added later)? The strategy does trim occasionally (oversized / earnings), so
   full support is cleaner, but exit-only is a smaller first step.
2. **Min buy** — keep the $50 floor? With notional it's arbitrary; could drop to ~$10 to deploy
   residual cash even more tightly, or keep $50 to avoid dust positions.
3. **N (book size)** — leave the shortlist at N≈6, or let the strategy widen now that share price no
   longer constrains slots? (Strategy question — separate decision; flagging that this unblocks it.)
