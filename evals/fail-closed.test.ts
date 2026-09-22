import { describe, test, expect } from "bun:test";
import { normalizeReportDate } from "@/lib/earnings";
import { pointsIncludeReport, getValuations, type XbrlPoint } from "@/lib/valuation";

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED DIRECTION INVARIANTS
//
// Written after a session in which I shipped the SAME defect three times: each
// time I added what I believed was a safety check, and each time it chose the
// fail-OPEN branch. Not one was caught by a test, because every test I wrote
// asserted the happy path and then asked "does it still pass?".
//
// The bug class is not "wrong value", it is "wrong DIRECTION under degradation".
// So these tests assert only direction, over every degraded input: when this
// system cannot establish that a P/E is sound, it must WITHHOLD the number.
// Withholding costs a missed opportunity; publishing a wrong multiple puts real
// money into a name for a reason that is not true. Those are not symmetric, and
// no test here should ever be relaxed to make a feature more "useful".
// ─────────────────────────────────────────────────────────────────────────────

const ptsPrePrint: XbrlPoint[] = [
  { start: "2026-01-01", end: "2026-03-31", val: 1, form: "10-Q", fy: 2026, fp: "Q1", filed: "2026-04-20" },
];

describe("normalizeReportDate never opens the gate", () => {
  // The exact values a vendor can emit. `undefined`/`null`/"" are the ones that bit: they are
  // falsy, and pointsIncludeReport's first line is `if (!reportDate) return true` -> PUBLISHED.
  const degraded = [undefined, null, "", "   ", "N/A", "null", "2026-9-5", "not a date",
                    0, NaN, [], {}, "2026-09-15T00:00:00Z<script>", "9".repeat(5000)];

  for (const raw of degraded) {
    test(`${JSON.stringify(raw)?.slice(0, 32) ?? String(raw)} -> non-falsy, bounded, unreadable`, () => {
      const out = normalizeReportDate(raw);
      expect(out).toBeTruthy();                       // falsy would PUBLISH downstream
      expect(out.length).toBeLessThanOrEqual(12);     // bounded: this reaches the live prompt
      // And it must actually suppress: unreadable by Date.parse means pointsIncludeReport = false.
      expect(pointsIncludeReport(ptsPrePrint, out)).toBe(false);
    });
  }

  test("a real date is passed through unharmed — the guard must not break the normal case", () => {
    expect(normalizeReportDate("2026-09-15")).toBe("2026-09-15");
    expect(normalizeReportDate("2026-09-15T00:00:00")).toBe("2026-09-15");
  });
});

describe("degraded inputs withhold the P/E rather than publish one", () => {
  const priceOf = () => 100;
  const SYM = `ZZFC${process.pid}`;
  const q = (n: number) => {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 3 * n);
    const e = d.toISOString().slice(0, 10);
    const s2 = new Date(d); s2.setUTCMonth(s2.getUTCMonth() - 3);
    return { start: s2.toISOString().slice(0, 10), end: e, val: 2, form: "10-Q", fy: 2026, fp: "Q1", filed: e };
  };
  const good = [q(0), q(1), q(2), q(3)];

  // Each row: a way the world degrades, and the claim that it withholds.
  const cases: Array<[string, Parameters<typeof getValuations>[3], () => Promise<XbrlPoint[]>]> = [
    ["a print whose filing has not landed", { reportedOn: new Map([[SYM, "2099-01-01"]]) }, async () => good],
    ["an unreadable report date", { reportedOn: new Map([[SYM, normalizeReportDate("garbage")]]) }, async () => good],
    ["SEC returning nothing", {}, async () => []],
  ];

  // A SEPARATE symbol per case. Sharing one key let case 1's successful cache write turn case 3
  // into a cache HIT: it never called its own fetchPoints, published, and the invariant went
  // unexercised. Invisible under `bun test` (NODE_ENV=test skips .env.local, so there is no cache
  // at all) and only reachable with creds — i.e. the suite silently stopped testing the thing.
  cases.forEach(([name, opts, fetchPoints], i) => {
    test(name, async () => {
      const sym = `${SYM}X${i}`;
      const remap = opts?.reportedOn
        ? { ...opts, reportedOn: new Map([...opts.reportedOn].map(([, v]) => [sym, v] as const)) }
        : (opts ?? {});
      const ctrl = new AbortController();
      const { valuations } = await getValuations([sym], priceOf, ctrl.signal, { ...remap, fetchPoints });
      expect(valuations.has(sym)).toBe(false);
    });
  });

  test("the CONTROL: undegraded input DOES publish, so the above cannot pass vacuously", async () => {
    const ctrl = new AbortController();
    const sym = `${SYM}CTRL`;
    const { valuations } = await getValuations([sym], priceOf, ctrl.signal, { fetchPoints: async () => good });
    expect(valuations.has(sym)).toBe(true);
  });
});
