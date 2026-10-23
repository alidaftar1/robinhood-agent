import { describe, expect, test } from "bun:test";
import { tookClaim, cronClaimKey, TRADE_ET_AT, CRON_ET_LATE_MIN, CRON_MAX_RUN_MIN, CRON_ET_EARLY_MIN, cronEtDecision, parseEtAt, requireCronEtWindow } from "../lib/cron-clock";
import { etParts } from "../lib/close-snapshot";

type Cron = { path: string; schedule: string };

/** Expand a cron field ("14", "14,15", "14-20") into its values. Only the forms vercel.json uses. */
function expand(field: string): number[] {
  return field.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    return b == null ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

/** Every UTC instant a cron fires on `day` (YYYY-MM-DD, a weekday). */
function firings(c: Cron, day: string): Date[] {
  const [min, hour] = c.schedule.split(" ");
  return expand(hour).flatMap((h) =>
    expand(min).map((m) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`)));
}

const noAlert = async () => {};
const etAtOf = (c: Cron) => new URL(c.path, "https://x").searchParams.get("etAt");
// The same ET clock the gate reads, so the test cannot drift from it.
const etHHMM = (d: Date) => {
  const m = etParts(d).minutes;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
};

// Mid-EDT, mid-EST, and the first weekdays either side of BOTH transitions (2026-11-01, 2027-03-14).
const DAYS = ["2026-07-15", "2026-10-30", "2026-11-02", "2027-01-15", "2027-03-12", "2027-03-15"];

// Routes whose handler verifies the ET clock ITSELF, so a single fixed-UTC cron is correct for them
// year-round and they need no etAt twin. close-snapshot refuses anything before the settled close
// (app/api/close-snapshot/route.ts) and is guarded by its own test in evals/close-snapshot.test.ts.
const SELF_CLOCKED = ["/api/close-snapshot"];
const selfClocked = (c: Cron) => SELF_CLOCKED.some((p) => c.path.startsWith(p));

describe("vercel.json crons fire at the same ET wall-clock time year-round", async () => {
  const cfg = (await Bun.file(`${import.meta.dir}/../vercel.json`).json()) as { crons: Cron[] };

  test("every cron declares the ET time(s) it means", () => {
    for (const c of cfg.crons.filter((c) => !selfClocked(c)))
      expect(etAtOf(c), `${c.path} has no etAt — it would drift an hour at DST`).not.toBeNull();
  });

  for (const c of cfg.crons.filter((c) => !selfClocked(c))) {
    test(`${c.path} — exactly one run per intended ET time, every season`, () => {
      const intended = etAtOf(c)!.split(",").sort();
      for (const day of DAYS) {
        const ran = firings(c, day)
          .filter((t) => cronEtDecision(etAtOf(c), t).run)
          .map(etHHMM)
          .sort();
        // Not just "the right count": the SAME ET times. Two runs would be trading twice; zero is a
        // missed job; an off-by-an-hour run is the very bug this exists to prevent.
        expect(ran, `${c.path} on ${day}`).toEqual(intended);
      }
    });
  }
});

describe("cronEtDecision", () => {
  test("no etAt is never gated — the manual/repair path must always run", () => {
    expect(cronEtDecision(null, new Date("2026-11-02T03:00:00Z")).run).toBe(true);
  });

  test("10:30 ET under EST runs at 15:30 UTC and skips 14:30 UTC (the opening bell)", () => {
    expect(cronEtDecision("1030", new Date("2026-11-02T15:30:00Z")).run).toBe(true);
    expect(cronEtDecision("1030", new Date("2026-11-02T14:30:00Z")).run).toBe(false);
  });

  test("tolerates invocation lag, but not an hour — and barely any earliness", () => {
    expect(cronEtDecision("1030", new Date("2026-07-15T14:45:00Z")).run).toBe(true);   // 15 min late
    expect(cronEtDecision("1030", new Date("2026-07-15T14:46:00Z")).run).toBe(false);  // 16 min late
    expect(cronEtDecision("1030", new Date("2026-07-15T14:20:00Z")).run).toBe(false);  // 10 min early
  });

  test("a pre-close job must be able to FINISH before 16:00, not merely start", () => {
    // The near-close stop check placing sells after the bell would sit until the next open. Last
    // start 15:54:59 + a full 5-minute maxDuration ends before the bell.
    expect(cronEtDecision("1545", new Date("2026-07-15T19:54:59Z")).run).toBe(true);   // 15:54:59 ET
    expect(cronEtDecision("1545", new Date("2026-07-15T19:55:00Z")).run).toBe(false);  // 15:55 ET
    expect(cronEtDecision("1545", new Date("2026-07-15T20:00:30Z")).run).toBe(false);  // 16:00:30 ET
  });

  test("the EST wrong twin (09:30 ET) only reaches the window after 55+ min of lag", () => {
    expect(cronEtDecision("1030", new Date("2026-11-02T15:20:00Z")).run).toBe(false);  // 09:30 + 50m lag
    expect(cronEtDecision("1030", new Date("2026-11-02T15:25:00Z")).run).toBe(true);   // 09:30 + 55m lag
  });

  test("the latest trade still finishes before the autopilot's ungated repair can look", async () => {
    // The autopilot's "run missing → call /api/trade" carries no etAt, so the claim cannot stop it.
    // If a late-but-accepted trade were still running when the autopilot fires, the repair would
    // start a SECOND live trade. Read both targets from vercel.json so moving either one re-checks.
    const cfg = (await Bun.file(`${import.meta.dir}/../vercel.json`).json()) as { crons: Cron[] };
    const etOf = (p: string) => parseEtAt(etAtOf(cfg.crons.find((c) => c.path.startsWith(p))!)!)[0];
    expect(etOf("/api/trade") + CRON_ET_LATE_MIN + CRON_MAX_RUN_MIN)
      .toBeLessThan(etOf("/api/autopilot") - CRON_ET_EARLY_MIN);
  });
});

describe("parseEtAt — fails loud on a bad config", () => {
  test("parses single and multiple times", () => {
    expect(parseEtAt("1030")).toEqual([630]);
    expect(parseEtAt("0900,1545")).toEqual([540, 945]);
  });
  test.each(["10:30", "", "2530", "1060", "930", "1555", "1559"])("rejects %p", (raw) => {
    expect(() => parseEtAt(raw)).toThrow();
  });
  test("a malformed etAt returns 500, not a silent skip", async () => {
    const res = await requireCronEtWindow(new Request("https://x/api/trade?etAt=10:30"), { claim: async () => true, alert: noAlert });
    expect(res?.status).toBe(500);
  });
  test("the off-hour twin returns 200 skipped", async () => {
    const res = await requireCronEtWindow(new Request("https://x/api/trade?etAt=1030"), { now: new Date("2026-11-02T14:30:00Z"), claim: async () => true, alert: noAlert });
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as { skipped: boolean }).skipped).toBe(true);
  });
});

describe("requireCronEtWindow — once per cron entry per ET day", () => {
  // In-memory stand-in for the Redis SET NX claim.
  const store = () => { const held = new Set<string>(); const keys: string[] = [];
    return { keys, claim: async (k: string) => { keys.push(k); if (held.has(k)) return false; held.add(k); return true; } }; };

  test("a twin delayed INTO the window cannot run the job a second time", async () => {
    const { claim } = store();
    const req = () => new Request("https://x/api/trade?etAt=1030");
    expect(await requireCronEtWindow(req(), { claimOnce: true, now: new Date("2026-11-02T15:25:00Z"), claim, alert: noAlert })).toBeNull();  // late wrong twin wins
    const second = await requireCronEtWindow(req(), { claimOnce: true, now: new Date("2026-11-02T15:30:00Z"), claim, alert: noAlert });     // right twin
    expect(((await second!.json()) as { skipped: boolean }).skipped).toBe(true);
  });

  test("next day is a fresh claim; distinct entries and distinct ET targets never share one", async () => {
    const { claim, keys } = store();
    expect(await requireCronEtWindow(new Request("https://x/api/trade?etAt=1030"), { claimOnce: true, now: new Date("2026-11-02T15:30:00Z"), claim, alert: noAlert })).toBeNull();
    expect(await requireCronEtWindow(new Request("https://x/api/trade?etAt=1030"), { claimOnce: true, now: new Date("2026-11-03T15:30:00Z"), claim, alert: noAlert })).toBeNull();
    const multi = "https://x/api/drop-check?scope=influencer&etAt=1000,1100";
    expect(await requireCronEtWindow(new Request(multi), { claimOnce: true, now: new Date("2026-11-02T15:00:00Z"), claim, alert: noAlert })).toBeNull();
    expect(await requireCronEtWindow(new Request(multi), { claimOnce: true, now: new Date("2026-11-02T16:00:00Z"), claim, alert: noAlert })).toBeNull();
    expect(new Set(keys).size).toBe(4);
  });

  test("an ungated call is never claimed and never blocked, even right after the cron ran", async () => {
    const { claim, keys } = store();
    await requireCronEtWindow(new Request("https://x/api/trade?etAt=1030"), { claimOnce: true, now: new Date("2026-11-02T15:30:00Z"), claim, alert: noAlert });
    expect(await requireCronEtWindow(new Request("https://x/api/trade"), { claimOnce: true, now: new Date("2026-11-02T15:31:00Z"), claim, alert: noAlert })).toBeNull();
    expect(keys.length).toBe(1);
  });
});

describe("a missed job is loud, and a Redis problem is never 'already ran'", () => {
  test("only an explicit null SET NX reply means the claim is held", () => {
    expect(tookClaim("OK")).toBe(true);
    expect(tookClaim(null)).toBe(false);
    // redisCommand returns json.result without checking res.ok, so an Upstash 401/429/5xx error body
    // arrives as undefined. Reading that as "held" would skip the trade AND log a false reason.
    expect(tookClaim(undefined)).toBe(true);
    expect(tookClaim({ error: "max daily request limit exceeded" })).toBe(true);
  });

  test("the intended run arriving after its window alerts; the wrong twin does not", async () => {
    const sent: string[] = [];
    const alert = async (subject: string) => { sent.push(subject); };
    const req = () => new Request("https://x/api/trade?etAt=1030");
    await requireCronEtWindow(req(), { now: new Date("2026-07-15T14:55:00Z"), alert });   // 10:55 ET: right run, 25m late
    expect(sent.length).toBe(1);
    await requireCronEtWindow(req(), { now: new Date("2026-07-15T15:30:00Z"), alert });   // 11:30 ET: EDT wrong twin
    await requireCronEtWindow(req(), { now: new Date("2026-11-02T14:30:00Z"), alert });   // 09:30 ET: EST wrong twin
    expect(sent.length).toBe(1);
  });

  test("routes without claimOnce never touch the claim", async () => {
    let touched = false;
    const r = await requireCronEtWindow(new Request("https://x/api/autopilot?cloudDispatch=1&etAt=1100"),
      { now: new Date("2026-07-15T15:00:00Z"), claim: async () => { touched = true; return false; }, alert: noAlert });
    expect(r).toBeNull();
    expect(touched).toBe(false);
  });

  test("the claim key ignores etAt and param order, keeps scope/t", () => {
    const k = (u: string) => cronClaimKey(new URL(u), 600, "2026-11-02");
    expect(k("https://x/api/drop-check?scope=influencer&etAt=1000,1100")).toBe(k("https://x/api/drop-check?etAt=1000,1100,1300&scope=influencer"));
    expect(k("https://x/api/drop-check?scope=influencer&t=close&etAt=1000")).not.toBe(k("https://x/api/drop-check?scope=influencer&etAt=1000"));
  });
});

describe("every gated cron's handler actually calls the gate", async () => {
  const cfg = (await Bun.file(`${import.meta.dir}/../vercel.json`).json()) as { crons: Cron[] };
  // Routes that PLACE ORDERS must also take the once-per-day claim.
  const ORDER_PLACING = ["/api/trade", "/api/drop-check"];
  test("order-placing routes cannot outrun CRON_MAX_RUN_MIN (the overlap and pre-close bounds assume it)", async () => {
    for (const path of ORDER_PLACING) {
      const src = await Bun.file(`${import.meta.dir}/../app${path}/route.ts`).text();
      const m = src.match(/export const maxDuration = (\d+);/);
      expect(m, `${path} must declare maxDuration`).not.toBeNull();
      expect(Number(m![1]) / 60, `${path} maxDuration`).toBeLessThanOrEqual(CRON_MAX_RUN_MIN);
    }
  });

  for (const c of cfg.crons.filter((c) => !selfClocked(c))) {
    const path = new URL(c.path, "https://x").pathname;
    test(`${path} gates on etAt${ORDER_PLACING.includes(path) ? " with claimOnce" : ""}`, async () => {
      // An etAt in vercel.json with no gate in the handler runs BOTH DST twins — twice a day.
      const src = await Bun.file(`${import.meta.dir}/../app${path}/route.ts`).text();
      expect(src).toMatch(ORDER_PLACING.includes(path)
        ? /await requireCronEtWindow\(request, \{ claimOnce: true \}\);/
        : /await requireCronEtWindow\(request\);/);
    });
  }
});

describe("the reviewer is told TODAY's concrete trade-cron UTC time", () => {
  test("14:30Z under EDT, 15:30Z under EST — computed, not left to the model", async () => {
    const { scheduledTradeCron } = await import("../lib/autopilot-review");
    expect(scheduledTradeCron("2026-10-30")).toStartWith("14:30 UTC");
    expect(scheduledTradeCron("2026-11-02")).toStartWith("15:30 UTC");
  });

  test("its ET target is the one vercel.json actually schedules", async () => {
    const cfg = (await Bun.file(`${import.meta.dir}/../vercel.json`).json()) as { crons: Cron[] };
    expect(etAtOf(cfg.crons.find((c) => c.path.startsWith("/api/trade"))!)).toBe(TRADE_ET_AT);
  });
});
