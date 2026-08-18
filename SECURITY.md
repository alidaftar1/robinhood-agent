# Security Policy

This repository runs a **live autonomous trading agent that moves real money**. Security reports are taken seriously and handled promptly.

## Reporting a vulnerability

**Please report privately — do not open a public issue for a security bug.**

Use GitHub's private vulnerability reporting:
**Security tab → "Report a vulnerability"** (or the repo's `/security/advisories/new` page).

This opens a private advisory visible only to you and the maintainer. Please include:
- what's wrong and where (file / route / workflow),
- how you reproduced it (ideally against your own clone, **never** against the live deployment),
- the impact you think it has.

You'll get an acknowledgement, and — with your permission — credit in the fix. Good-faith research is welcome; please don't run tests against the production deployment or place trades.

With thanks to **Hirad Peyvandi**, whose responsible disclosure of a fail-open authentication gap kicked off the hardening this policy documents.

## For contributors

This is a live-money codebase, so security invariants are **hard constraints**, not guidelines. Before changing anything that touches auth, secrets, permissions, the trade path, or CI, read the **"Security Invariants"** section of [`CLAUDE.md`](./CLAUDE.md). In short:

- **Fail closed** on a missing required secret — never fall back to running unprotected.
- **No working fallback for a security-sensitive value** (`SECRET ?? ""` is the anti-pattern).
- **One secret, one job** — a low-stakes key must not double as a high-stakes one.
- **No secrets in URLs, logs, or transcripts** — use headers or an httpOnly/Secure/SameSite=Strict cookie.
- **A reasoning LLM never holds the trade token** — it decides; code applies the guardrails; a constrained executor places only pre-computed orders.
- **"Worked locally" is not "safe"** — write the negative/adversarial test, not just the happy path.

## Scope

In scope: this repository's code, API routes, GitHub Actions workflows, and configuration. Out of scope: third-party services (Vercel, GitHub, Robinhood, Anthropic, data providers) — report those to the respective vendor.
