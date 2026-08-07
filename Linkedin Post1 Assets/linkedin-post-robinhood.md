# LinkedIn Post — Robinhood AI Trading Agent

**Target audiences:**
- Primary: PM hiring managers / teams looking for PMs who've shipped real AI products
- Secondary: Developers, financial advisors, builders who might want to replicate or hire for consulting

**Format:** Single post with 3–4 screenshot carousel (package as PDF for best reach)

---

## Draft Copy

I gave Claude a Robinhood account and told it to manage my money.

Not a simulation. Real trades, real portfolio, every weekday at 7:30am — no human involved.

Here's what I actually built (and what I learned building it as a PM):

**The system:**
- Analyzes 450+ S&P 500 stocks using momentum signals, insider trading filings, analyst upgrades, and earnings calendars
- Claude writes a thesis and outputs a structured trade decision
- Two separate sessions execute buys and sells via Robinhood's API
- Logs every run, monitors itself, emails me a daily summary
- Runs completely unattended on a $0/month Vercel cron

**What I actually spent my time on as a PM (not what you'd expect):**

The model isn't the hard part. I spent most of my time on:
- Session architecture: a single Claude session kept timing out at 270s. Split it into three (analysis → sells → buys) and that solved it
- Evals: built a 12-scenario eval suite with an LLM-as-judge so I can change the strategy without breaking behavior I already tested
- Constraints: T+1 settlement, budget caps, account isolation — the boring stuff that makes the difference between a demo and something that runs in production
- Observability: daily return calculation, deposit detection, run deduplication — you don't notice these until something goes wrong at 7:30am and you're debugging before coffee

**The PM lesson I keep coming back to:**

Building AI products isn't about prompting. It's about designing for failure modes, defining what "correct" looks like before you ship, and building enough observability to know when the model is drifting.

Anyone can wire Claude to an API in an afternoon. Knowing what to test, what to constrain, and what to leave to the model — that's the actual job.

---

Planning to open-source the architecture. If you're a financial advisor, developer, or builder curious about autonomous AI agents for financial decision-making — or just want to talk AI product work — DM me or drop a comment.

---

## Screenshots (to collect before posting)

1. **Dashboard** — performance chart (agentic vs personal vs SPY) + portfolio card
   - Blur/redact: account numbers, exact dollar amounts (your call)

2. **Braintrust eval dashboard** — 25 scenarios with per-check scores and LLM judge
   - More visually interesting than terminal output; highlights evals tooling

3. **Autopilot email** — the daily summary email in your inbox
   - Wait for Monday's run to get a clean one

4. **Run card / trade thesis** — dashboard showing the TRADE_DECISION thesis text for a recent run
   - Shows the reasoning, not just the action

**Format tip:** Package as a PDF carousel — LinkedIn carousels get significantly more engagement than single images.

**Redact before posting:**
- Account numbers (670284256, 995823622)
- CRON_SECRET
- Exact portfolio dollar amounts (optional — your call)

---

## Pending decisions

- [ ] Include actual portfolio performance numbers? (return %, # trades placed)
- [ ] Mention GitHub now ("coming soon") or wait until repo is live?
- [ ] Tone check — current draft is direct/slightly provocative, adjust if needed
- [ ] Add your name / ex-Meta context in opening or keep it product-focused?
