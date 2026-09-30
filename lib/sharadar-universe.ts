// ─────────────────────────────────────────────────────────────────────────────
// POINT-IN-TIME S&P 500 MEMBERSHIP, from Sharadar's sp500 table.
//
// This is the single file that decides whether a backtest is survivorship-free. Get it wrong and
// every result is flattering nonsense — you would be testing "the companies that made it to 2026",
// which is a universe selected on the outcome you are trying to measure.
//
// TWO TRAPS, both live:
//
// 1. NEVER RESOLVE MEMBERSHIP FORWARD. The snapshot on or BEFORE the date is the only safe one.
//    Reaching for the next snapshot leaks the future: on 2008-06-01 you would "know" which banks
//    were still in the index at 2008-09-30.
//
// 2. DELISTED TICKERS CARRY A SUFFIX. Lehman is LEHMQ, Wachovia is WB1, Safeco is SAF2 — not LEH,
//    WB, SAF. Querying the symbol you'd expect returns ZERO ROWS AND NO ERROR, which reads exactly
//    like "this name has no data" while actually being "I silently dropped the bankruptcy". The
//    failed companies are the entire point, so tickers must come from THIS table and never be
//    guessed or re-derived from a modern symbol list. (Caught for real: a hand-written LEH query
//    came back empty and nearly passed as missing data.)
// ─────────────────────────────────────────────────────────────────────────────

export interface Sp500Row {
  date: string;      // YYYY-MM-DD
  action: "historical" | "current" | "added" | "removed" | string;
  ticker: string;
  name: string;
}

/** Parse the sp500 CSV. Tolerant of quoted fields containing commas (company names do). */
export function parseSp500Csv(csv: string): Sp500Row[] {
  const lines = csv.split("\n");
  const out: Sp500Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f.length < 4) continue;
    const [date, action, ticker, name] = f;
    if (!date || !ticker) continue;
    out.push({ date, action, ticker, name: name ?? "" });
  }
  return out;
}

/** Minimal RFC-4180-ish splitter: handles "quoted, fields" without pulling in a CSV dependency. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

export interface UniverseIndex {
  /** Snapshot dates, ascending. */
  snapshotDates: string[];
  /** Snapshot date → member tickers. */
  membersByDate: Map<string, Set<string>>;
  /** Every ticker ever in the index — INCLUDING delisted, with their real suffixed symbols. */
  allTickers: Set<string>;
}

/**
 * Build the index from the raw rows. Uses `historical` quarterly snapshots plus the latest
 * `current` set. `added`/`removed` are deliberately NOT applied as deltas here: reconciling deltas
 * against snapshots can drift, and a drifted universe fails silently. The cost is up to one
 * quarter of staleness, which is STALE rather than LOOK-AHEAD — a name that left the index may
 * linger a few weeks. That errs in the safe direction; a forward-resolved universe does not.
 */
export function buildUniverseIndex(rows: Sp500Row[]): UniverseIndex {
  const membersByDate = new Map<string, Set<string>>();
  const allTickers = new Set<string>();
  for (const r of rows) {
    allTickers.add(r.ticker);
    if (r.action !== "historical" && r.action !== "current") continue;
    let set = membersByDate.get(r.date);
    if (!set) { set = new Set<string>(); membersByDate.set(r.date, set); }
    set.add(r.ticker);
  }
  const snapshotDates = [...membersByDate.keys()].sort();
  return { snapshotDates, membersByDate, allTickers };
}

/**
 * Index members as of `date`. BACKWARD-LOOKING ONLY — returns the most recent snapshot on or
 * before `date`, and null when `date` predates the first snapshot (rather than reaching forward
 * for the nearest one, which would be exactly the look-ahead this module exists to prevent).
 */
export function membersAsOf(idx: UniverseIndex, date: string): Set<string> | null {
  let lo = 0, hi = idx.snapshotDates.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.snapshotDates[mid] <= date) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best < 0) return null;                     // before coverage — NOT the first snapshot
  return idx.membersByDate.get(idx.snapshotDates[best]) ?? null;
}

/**
 * Members as of `date`, with dated add/remove deltas applied on top of the last snapshot.
 *
 * Snapshots are QUARTERLY, so membersAsOf alone can be ~77 days stale — during the GFC that is
 * roughly eight wrong names out of 500. The `added`/`removed` rows carry exact dates, so replaying
 * the ones strictly after the snapshot and on-or-before `date` is both more accurate and STILL
 * purely backward-looking: nothing dated after `date` is ever consulted.
 *
 * Validated by reconcileDeltas() below rather than assumed — if the deltas did not reproduce the
 * next snapshot, this would silently trade a drifting universe.
 */
export function membersAsOfPrecise(
  idx: UniverseIndex,
  rows: Sp500Row[],
  date: string,
): Set<string> | null {
  const base = membersAsOf(idx, date);
  if (!base) return null;
  const snapDate = lastSnapshotOnOrBefore(idx, date);
  if (!snapDate) return null;
  const out = new Set(base);
  for (const r of rows) {
    if (r.date <= snapDate || r.date > date) continue;   // strictly after snapshot, at most `date`
    if (r.action === "added") out.add(r.ticker);
    else if (r.action === "removed") out.delete(r.ticker);
  }
  return out;
}

export function lastSnapshotOnOrBefore(idx: UniverseIndex, date: string): string | null {
  let lo = 0, hi = idx.snapshotDates.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.snapshotDates[mid] <= date) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best < 0 ? null : idx.snapshotDates[best];
}

/**
 * Do the dated deltas actually reproduce the NEXT snapshot? Returns per-snapshot disagreement
 * counts. This is the check that makes membersAsOfPrecise trustworthy: a delta stream that drifts
 * would produce a universe that is wrong in a way no result would ever reveal.
 */
export function reconcileDeltas(idx: UniverseIndex, rows: Sp500Row[]): Array<{
  from: string; to: string; expected: number; got: number; missing: number; extra: number;
}> {
  const out = [];
  for (let i = 0; i + 1 < idx.snapshotDates.length; i++) {
    const from = idx.snapshotDates[i], to = idx.snapshotDates[i + 1];
    // Build the prediction from the EARLIER snapshot and roll deltas forward into (from, to].
    // Deliberately NOT membersAsOfPrecise(…, to): lastSnapshotOnOrBefore is INCLUSIVE, so that
    // would resolve `to` to itself, apply zero deltas, and compare a snapshot against itself — a
    // vacuous check that reported 114/114 perfect while testing nothing. Caught by a mutation test
    // that deleted a `removed` row and still passed.
    const base = idx.membersByDate.get(from);
    const actual = idx.membersByDate.get(to);
    if (!base || !actual) continue;
    const predicted = new Set(base);
    for (const r of rows) {
      if (r.date <= from || r.date > to) continue;
      if (r.action === "added") predicted.add(r.ticker);
      else if (r.action === "removed") predicted.delete(r.ticker);
    }
    let missing = 0, extra = 0;
    for (const t of actual) if (!predicted.has(t)) missing++;
    for (const t of predicted) if (!actual.has(t)) extra++;
    out.push({ from, to, expected: actual.size, got: predicted.size, missing, extra });
  }
  return out;
}

/** How stale the resolved snapshot is, in days. Surfaced so a caller can report it rather than
 *  quietly trading a universe from three months ago. */
export function snapshotAgeDays(idx: UniverseIndex, date: string): number | null {
  let lo = 0, hi = idx.snapshotDates.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.snapshotDates[mid] <= date) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best < 0) return null;
  const a = Date.parse(`${idx.snapshotDates[best]}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

/** Names REMOVED from the index in a window, with the stated reason. The failed companies are the
 *  point of a survivorship-free test, so this exists to let a run PROVE it saw them. */
export function removalsBetween(rows: Sp500Row[], from: string, to: string): Sp500Row[] {
  return rows.filter(r => r.action === "removed" && r.date >= from && r.date <= to);
}
