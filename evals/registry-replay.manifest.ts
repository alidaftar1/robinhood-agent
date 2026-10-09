// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY REPLAY — does the suite still catch the bugs we have already had?
//
// lib/autopilot-known-issues.ts holds 35 documented incidents: real failures, each with what broke
// and why it mattered. It is a labelled bug corpus built over months, and until now nothing read it
// except the skeptical reviewer's prompt.
//
// Each entry below RE-INTRODUCES one of those incidents as a concrete code change, then asks the
// fast gate whether anything goes red. The score — caught / replayable — is a benchmark of the TEST
// SUITE, not of the agent.
//
// WHY THIS BEATS HAND-WRITTEN MUTATIONS. I write both the code and its mutations, so a mutation
// battery mostly confirms I guarded what I already thought of: ~40 mutations passed this week while
// thirteen real defects shipped. These incidents were NOT authored to be caught. They happened.
//
// HONEST DENOMINATOR. Only incidents reproducible as a deterministic code change are listed as
// replayable. The rest are recorded with `replayable: false` and a reason, so the score is never
// flattered by quietly dropping the hard ones — an LLM-judgment failure genuinely cannot be
// replayed this way, and pretending otherwise would be the easiest way to fake a good number.
// ─────────────────────────────────────────────────────────────────────────────

export type ReplayCase = {
  /** Registry date + a short handle. */
  id: string;
  /** The incident, as the registry titles it. */
  incident: string;
} & (
  | {
      replayable: true;
      /** The file to change, relative to the repo root. */
      file: string;
      /** Exact text to replace — must appear EXACTLY ONCE, or the case reports as broken rather
       *  than silently mutating the wrong thing (or nothing). */
      find: string;
      /** What to put there: the bug, re-introduced. */
      replace: string;
      /** What the suite SHOULD notice. Prose, for the report only. */
      expect: string;
    }
  | { replayable: false; why: string }
);

export const REPLAY_CASES: ReplayCase[] = [
  {
    id: "2026-10-06/sleeve-split-unrepaired",
    incident: "A repaired whole-account return left the SLEEVE split computed from the unrepaired trades",
    replayable: true,
    file: "app/api/debug/route.ts",
    find: ", ...sleevesFor(patchedTrades) });",
    replace: " });",
    expect: "patchTrades repairs the headline return but leaves mainDailyReturn phantom (-27.65% live)",
  },
  {
    id: "2026-10-07/capture-never-called",
    incident: "planCapture shipped complete and the autopilot never passed ?capture=1",
    replayable: true,
    file: "app/api/autopilot/route.ts",
    find: "`${host}/api/verify?capture=1`",
    replace: "`${host}/api/verify`",
    expect: "the owner's broker fills are never recorded; the feature is inert",
  },
  {
    id: "2026-10-06/stale-snapshot-exit",
    incident: "drop-check placed a sell for a position the owner had already closed",
    replayable: true,
    file: "app/api/drop-check/route.ts",
    find: "const pre = sellsToExecute.length > 0 ? await fetchLiveState() : null;",
    replace: "const pre = null as Awaited<ReturnType<typeof fetchLiveState>>;",
    expect: "exits are decided from the 07:30 snapshot with no live re-read",
  },
  {
    id: "2026-07-10/tiny-prior-day-base",
    incident: "Sleeve return distorted by a tiny prior-day base (book rebuilt from cash)",
    replayable: true,
    file: "lib/run-store.ts",
    find: "yst.length > 0 && materialBase(today, yst)",
    replace: "yst.length > 0",
    expect: "a sleeve rebuilt from cash reports a phantom daily return instead of null",
  },
  {
    id: "2026-10-06/saverun-swallows-failure",
    incident: "saveRun returned void and swallowed failures; drop-check emailed success for a run that never persisted",
    replayable: true,
    file: "lib/run-store.ts",
    // The ORIGINAL bug was a swallowed failure reported as success, so the mutation has to make the
    // catch lie. A first attempt inserted `if (0) return false;` — dead code that changed nothing,
    // so the case "failed" while testing absolutely nothing. A mutation that does not mutate is the
    // quietest way to fake a bad score.
    find: `    console.error("SAVE_RUN_FAILED", { date: run.date, timestamp: run.timestamp, error: String(e) });\n    return false;`,
    replace: `    console.error("SAVE_RUN_FAILED", { date: run.date, timestamp: run.timestamp, error: String(e) });\n    return true;`,
    expect: "a caller cannot distinguish a persisted run from a lost one",
  },
  {
    id: "2026-10-08/exit-ledger-wipes-history",
    incident: "A ledger that treats an unreadable store as empty overwrites its own history",
    replayable: true,
    file: "lib/exit-ledger.ts",
    find: "    if (!res.ok) return null;",
    replace: "    if (!res.ok) return [];",
    expect: "a transient Upstash error wipes the accumulated exits",
  },
  {
    id: "2026-10-08/ledger-write-via-get-url",
    incident: "A ledger SET encoded into a GET URL fails silently past ~53 records",
    replayable: true,
    file: "lib/exit-ledger.ts",
    find: `    const res = await fetch(\`\${url}/pipeline\`, {`,
    replace: `    const res = await fetch(\`\${url}/set/\${LEDGER_KEY}\`, {`,
    expect: "the write path leaves /pipeline and silently truncates as the ledger grows",
  },
  {
    id: "2026-10-08/exit-trigger-guessed",
    incident: "An unlabelled exit filed under a real trigger corrupts that trigger's measurement",
    replayable: true,
    file: "lib/exit-ledger.ts",
    find: `return (known as string[]).includes(r) ? (r as ExitTrigger) : "discretionary";`,
    replace: `return (known as string[]).includes(r) ? (r as ExitTrigger) : "news-down";`,
    expect: "unknown reasons inflate whichever trigger the default points at",
  },
  {
    id: "2026-10-06/provenance-unstamped",
    incident: "A human fill and an agent fill are indistinguishable once written",
    replayable: true,
    file: "app/api/drop-check/route.ts",
    find: `state: v.state, actor: "agent",`,
    replace: `state: v.state,`,
    expect: "an order path stops recording who placed it; unrecoverable afterwards",
  },
  {
    id: "2026-10-08/exit-ledger-unwired",
    incident: "A sell path silently stops feeding the exit ledger, biasing every trigger average",
    replayable: true,
    file: "app/api/earnings-exit/route.ts",
    find: "    await recordExits(",
    replace: "    await Promise.resolve(",
    expect: "earnings exits vanish from the measurement with nothing saying so",
  },

  // ── NOT REPLAYABLE as a deterministic code change ──────────────────────────
  { id: "2026-09-01/bolded-decision-marker", replayable: false,
    incident: "A markdown-BOLDED TRADE_DECISION marker silently cancelled an entire run",
    why: "Reproduces only through live model OUTPUT formatting. Belongs in the LLM suite (evals/eval.test.ts), which this gate deliberately excludes." },
  { id: "2026-08-11/reviewer-stale-price-memory", replayable: false,
    incident: "Reviewer flagged a real, verified price as anomalous from stale training-era memory",
    why: "A model-judgment failure. evals/reviewer-recall.ts is the right harness — it already scores recall and specificity against labelled fixtures." },
  { id: "2026-06-23/silent-self-heal", replayable: false,
    incident: "Silent self-heal masks a failed morning",
    why: "Needs a run whose TIMESTAMP is late relative to the cron — a data state, not a code path. A fixture-based test would catch it; no mutation can express it." },
  { id: "2026-09-03/cloud-job-timeout", replayable: false,
    incident: "Cloud-autopilot GH Actions job hit its own timeout mid-run",
    why: "Infrastructure behaviour outside the codebase. Caught by workflow timeouts, not by tests." },
];
