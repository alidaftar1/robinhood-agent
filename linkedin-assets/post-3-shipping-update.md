# LinkedIn Post #3 — "What I shipped since the last post" (features roundup + the AI lesson)

**Status:** FINAL (2026-06-30). Paste-ready, no-markdown version → `post-3-LINKEDIN-ready.txt`.
**Angle:** ~Two weeks after "my AI is losing to SPY," here's what I rebuilt — risk panel, influencer sleeve, cloud autopilot — plus the deterministic-vs-LLM lesson that surprised me.
**Order:** 1 risk panel → 2 influencer sleeve → 3 cloud autopilot → the lesson. (Tried swapping 2/3, reverted — cloud autopilot flows straight into the deterministic-vs-LLM lesson since both are the oversight layer.)
**Visual:** the carousel (`carousel/carousel.pdf`, or the 5 `carousel/slide-*.png`). Architecture diagram (`robinhood-agent-architecture@2x.png`) is slide 2.
**Supersedes:** the narrower `post-3-risk-signals.md` (its risk-panel/commenter content is folded in as section 1 here).

---

## THE POST (final body — clean paste version lives in post-3-LINKEDIN-ready.txt)

A couple of weeks ago I posted that my AI trading agent was losing to the S&P 500.

The most useful reply wasn't "just buy an index fund." It was a super insightful comment:

*"Your problem isn't the AI's stock picks — it's structural. Stop adding signals and go measure your risk."*

So I spent the next stretch rebuilding. Three things changed — and the last one taught me something about AI I didn't expect.

—

**1. A risk panel — measuring the agent against the market, not just its P&L.**

Beta. Sector exposure. Cash drag. Drawdown vs the S&P.

The first thing it surfaced: the book was ~79% concentrated in a single sector, and I had no idea — it built up one reasonable trade at a time. I added a hard 40% cap.

Amin Rasooli was right: measuring your risk explains more than obsessing over your returns.

**2. A high-risk "influencer sleeve."**

25% of the budget now trades on stock picks pulled from finance YouTubers — a separate, aggressive bucket next to the S&P momentum book, with its own guardrails: max 2 positions, a −5% stop, a +20% take-profit, and a falling-knife filter.

Its very first pick was a stock the AI called "SPACE." There's no such ticker — it was reaching for the just-IPO'd SpaceX. A validation layer caught the hallucination and resolved it to the real symbol before a dollar moved.

Guardrails beat models.

**3. A cloud autopilot that fixes and ships its own bugs.**

Every weekday morning, an AI agent — running in GitHub Actions, off my laptop — reads the system's health, diagnoses code-level bugs, runs the eval suite, and deploys the fix to production behind a review gate.

The trading system now largely maintains itself.

—

**The lesson I didn't expect: deterministic vs. LLM.**

I'd layered AI oversight on top of the AI — an LLM "reviewer" to judge each morning's run. Then reality taught me where LLMs actually belong.

The reviewer kept hallucinating problems that weren't there — once flagging a holding as "missing" that was sitting right there in the data it was handed. Meanwhile the boring, deterministic checks — does the cash reconcile? did any order silently fail? — caught the one bug that actually cost me money.

The takeaway I keep coming back to: use LLMs for judgment, never as your source of truth. The unglamorous if-statements are still what keep real money safe.

—

Still building in public. Barely beating the market but not meaningfully yet. Full architecture attached and link to github and the public dashboard below in comments 👇

What would you build next?

---

## STATUS / NOTES
- **Commenter:** Amin Rasooli — credited in section 1; tagged as a LIVE @mention in the composer (done, not plain text).
- **Performance line** ("barely beating the market but not meaningfully yet") — verified 2026-06-30: agent −0.32% vs SPY −1.50% = **+1.18 pts ahead** (ahead by losing less on a down tape; honest "not meaningfully yet" caveat kept). Matches the dashboard's own "+1.18% · BEATING THE MARKET" label, so it's corroborated if anyone clicks through. Re-check before posting (moves daily).
- **Accuracy checks (all hold):** SPACE→SPCX (caught the hallucination; don't imply SPCX profited — sleeve is honestly shown at −16% on the dashboard); ~79%→40% cap (live dashboard shows current ~37%, the "added a cap" line explains it); dropped-sell bug = BAX (deterministic catch).

## LINKS (in comments, not the post body — LinkedIn suppresses in-body links)
- **1st comment:** live dashboard → https://robinhood-agent.vercel.app/public  (verified keyless, no key leak)
- **2nd comment:** repo → https://github.com/alidaftar1/robinhood-agent

## LAUNCH NOTES (from ~/Desktop/linkedin-launch-checklist.md)
- Attach the carousel (`carousel/carousel.pdf` as a Document, or the 5 slide PNGs as a multi-image post).
- Post Tue–Thu ~8am PT. Seed 5–8 peer comments in the first 30 min (peers, not family).
- Post the dashboard link as the first comment immediately after publishing (top slot + early engagement signal).
- Reply to Amin's original comment on Post #1 ("built what you suggested — here it is: [link]") to reliably pull him in.
- One broad CTA question — already in the draft.
