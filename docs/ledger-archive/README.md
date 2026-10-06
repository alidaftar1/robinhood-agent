# Influencer-ledger archive

Point-in-time exports of `/api/influencer-ledger`, kept because **the live ledger was RESET on
2026-10-03 and these are the only surviving record of what it held before that.** The reset was
deliberate — the measurement pipeline underneath it had changed enough that the old rows were not
comparable — but the picks themselves are not reconstructable from anywhere else: the influencer
signal cache has a 7-day TTL, so the mentions behind these rows are long gone.

| file | asOf | picks | channels |
|---|---|---|---|
| `influencer-ledger-snapshot-2026-10-02.json` | 2026-10-02 | 50 | 7 |
| `influencer-ledger-prereset-2026-10-03.json` | 2026-10-03 | 36 | 5 |

## What these numbers are NOT

Do not read the returns in these files as a verdict on any channel, and do not pool them with
post-reset data. They were produced by the pre-2026-10-03 measurement, which had three defects the
reset exists to escape:

- **Union credit.** Every channel mentioning a ticker inherited the ticker-level baseline, so a
  channel that named an already-running winner was credited with the entire prior run-up.
- **Pre-market baselines.** The cache cron runs 13:00 UTC, 30 minutes *before* the 13:30 open, so a
  baseline could be a pre-market print — crediting the whole of that day's move, permanently.
- **No horizon and no avoid-close.** Credits ran open-ended to "now", so a channel was charged with
  a crash it had explicitly warned about, and a three-day-old pick moved the same statistic as a
  three-month-old one.

The current ledger credits each channel from its own first mention, baselines on the first close
strictly after the video's `publishedAt`, closes a credit at 30 days or at the channel's own avoid
(earliest wins), and reports score cohorts separately. See `lib/influencer-ledger.ts`.

## Why keep them anyway

Two uses that survive the caveats: the **pick lists** are a real record of what these channels were
naming in Sep–Oct 2026 (useful later for coverage and overlap questions, which the defects above do
not touch), and they are the before-picture if anyone asks what the reset discarded.
