/**
 * ET wall-clock gate for Vercel crons.
 *
 * WHY THIS EXISTS. Vercel cron schedules are UTC-only, the market runs on America/New_York, and the
 * offset between them changes twice a year. A cron pinned at `30 14` is 10:30 ET under EDT and 9:30
 * ET — the opening bell — under EST, and nothing anywhere notices: the return series silently
 * changes from 10:30→10:30 to open→open mid-track-record, and `drop-check?t=close` stops being near
 * the close. So every job is scheduled at BOTH candidate UTC hours, and the cron URL carries the ET
 * time(s) it actually means (`?etAt=1030`, or `?etAt=1000,1100` for a multi-hour job). The handler
 * runs only on the invocation that lands at an intended ET time and skips the other.
 *
 * FAIL-SAFE DIRECTION. A request WITHOUT `etAt` is never suppressed — a manual call, the
 * autopilot's "today's run is missing → call /api/trade" repair, and the GitHub cron.yml fallback
 * all carry no param. Running an order-placing job TWICE is the dangerous direction, so it has two
 * independent guards: an ASYMMETRIC window (the wrong twin is 60 minutes early, or 60 minutes late
 * plus lag — only lateness is realistic, so the window is narrow before the target and wider after),
 * and, for the routes that place orders, a once-per-day Redis claim per cron entry, so that even a
 * twin delayed into the window cannot run the job a second time.
 *
 * MISSING A JOB must not be silent either. The autopilot repair sits behind this same gate, so
 * anything that pushes every invocation out of the window would skip the trade AND its repair with
 * green crons. An invocation that lands in the gap where only a LATE intended run can be (past the
 * window, well short of the wrong twin's +60) therefore alerts by email rather than just logging.
 *
 * KNOWN TRAP: the Vercel dashboard's "Run" button invokes the configured path, etAt included, so
 * outside the window it returns 200 {skipped:true} and does nothing. To run a job by hand, call
 * the path WITHOUT etAt.
 */
import { etParts } from "./close-snapshot";
import { redisCommand } from "./run-store";
import { sendAlert } from "./alert";

/** How far before / after an intended ET time an invocation still counts as on time. The wrong
 *  twin is 60 minutes away: it would need to fire 55 minutes EARLY, or arrive 45 minutes LATE (and,
 *  on a claimed route, beat the right twin to the daily claim) to run instead of it.
 *
 *  The LATE bound is also what keeps /api/trade from overlapping the 11:00 ET autopilot, whose
 *  "today's run is missing" repair calls /api/trade WITHOUT etAt — so the claim cannot see it. A
 *  10:30 trade starting by 10:45 and running its full 5-minute maxDuration is stored by 10:50,
 *  before the autopilot looks. evals/cron-clock.test.ts pins that arithmetic against vercel.json;
 *  widening this without moving the autopilot would let the repair start a SECOND live trade. */
export const CRON_ET_EARLY_MIN = 5;
export const CRON_ET_LATE_MIN = 15;
/** Upper bound on a gated route's own runtime (Vercel maxDuration 300s). evals/cron-clock.test.ts
 *  reads each order-placing route's maxDuration and fails if it exceeds this. */
export const CRON_MAX_RUN_MIN = 5;
/** The trade cron's ET target. The single definition: vercel.json's `/api/trade?etAt=` must equal
 *  it (pinned by evals/cron-clock.test.ts), and the autopilot reviewer derives its expected run
 *  time from it, so moving the trade moves what the reviewer is told. */
export const TRADE_ET_AT = "1030";
/** Past the window but this close to the target, the invocation can only be the INTENDED run
 *  arriving late — the wrong twin lands at +60. Skipped, and alerted. */
export const CRON_ET_LATE_ALERT_MIN = 45;
/** 16:00 ET. A job targeted before the close must FINISH before it, not merely start: a "near the
 *  close" stop check placing sells after the bell leaves orders sitting until the next open. So its
 *  last allowed start is the close minus a full maxDuration, minus one minute because etParts
 *  truncates to the minute (minute 954 covers 15:54:00-15:54:59). */
const CLOSE_MIN = 16 * 60;
const LAST_PRE_CLOSE_START = CLOSE_MIN - CRON_MAX_RUN_MIN - 1;

/** Parse `etAt` ("1030" or "1000,1100,1500") into minutes after midnight ET. Throws on a malformed
 *  value rather than returning [] — an empty list would skip the job every day, silently. */
export function parseEtAt(raw: string): number[] {
  const out = raw.split(",").map((s) => {
    const t = s.trim();
    if (!/^\d{4}$/.test(t)) throw new Error(`bad etAt entry "${t}" — expected HHMM`);
    const h = Number(t.slice(0, 2)), m = Number(t.slice(2));
    if (h > 23 || m > 59) throw new Error(`bad etAt entry "${t}" — out of range`);
    const min = h * 60 + m;
    // A pre-close target after the last allowed start could never run on time: every invocation
    // would be classed late, skipped and alerted, daily. A config error — fail at parse instead.
    if (min > LAST_PRE_CLOSE_START && min < CLOSE_MIN)
      throw new Error(`etAt "${t}" can never run — a pre-close job must start by ${hhmm(LAST_PRE_CLOSE_START)} ET to finish before the 16:00 close`);
    return min;
  });
  if (out.length === 0) throw new Error("empty etAt");
  return out;
}

const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

const windowEnd = (t: number) => (t < CLOSE_MIN ? Math.min(t + CRON_ET_LATE_MIN, LAST_PRE_CLOSE_START) : t + CRON_ET_LATE_MIN);

/** Pure decision: should a cron invocation at `now` run, given its `etAt` param? `target` is the
 *  matched ET time (minutes) for an on-time gated call, null otherwise. `late` marks a skip that
 *  can only be the intended run arriving after its window. */
export function cronEtDecision(
  etAt: string | null, now: Date,
): { run: boolean; reason: string; target: number | null; etDate: string; late: boolean } {
  const { date: etDate, minutes } = etParts(now);
  if (etAt == null) return { run: true, reason: "no etAt — manual or repair call, never gated", target: null, etDate, late: false };
  const targets = parseEtAt(etAt);
  const hit = targets.find((t) => minutes >= t - CRON_ET_EARLY_MIN && minutes <= windowEnd(t));
  if (hit != null) return { run: true, reason: `on time for ${hhmm(hit)} ET`, target: hit, etDate, late: false };
  const lateFor = targets.find((t) => minutes > windowEnd(t) && minutes <= t + CRON_ET_LATE_ALERT_MIN);
  return lateFor != null
    ? { run: false, reason: `now ${hhmm(minutes)} ET is past the window for ${hhmm(lateFor)} ET — the intended run arrived LATE and was skipped`, target: null, etDate, late: true }
    : { run: false, reason: `now ${hhmm(minutes)} ET is outside the window for ${targets.map(hhmm).join("/")} ET — this is the off-hour DST twin of the cron`, target: null, etDate, late: false };
}

type Claim = (key: string) => Promise<boolean>;

/** Did THIS call acquire the claim? Only an explicit null SET NX reply means another invocation
 *  already holds it; every other non-"OK" reply is a Redis problem and must NOT read as "already
 *  ran" (see redisClaim). true = proceed. */
export function tookClaim(reply: unknown): boolean {
  return reply !== null;
}

/** SET NX: true if this call took the claim, false ONLY when Redis affirmatively says an earlier
 *  invocation holds it (a null reply). Anything else — a thrown error, a timeout, or an Upstash
 *  error body, which redisCommand returns as an undefined result rather than throwing — claims
 *  (returns true): the window is the primary guard and this is the backstop, so a Redis problem
 *  must never be read as "already ran" and turn into a missed trade. 3s cap so a hung Upstash call
 *  cannot eat the route's maxDuration. 30h TTL: outlives the day, gone before the next one. */
const redisClaim: Claim = async (key) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      redisCommand("set", key, "1", "NX", "EX", 108_000),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("claim timed out after 3s")), 3000); }),
    ]);
    const took = tookClaim(reply);
    if (reply !== "OK" && reply !== null) console.error("CRON_ET_CLAIM_UNEXPECTED_REPLY", { key, reply });
    return took;
  } catch (e) {
    console.error("CRON_ET_CLAIM_ERROR", { key, error: String(e) });
    return true;
  } finally {
    clearTimeout(timer);
  }
};

/** Claim key: the cron entry's identity (path + every param that changes what the job does) +
 *  the matched ET target + the ET date. etAt itself is EXCLUDED, so editing the entry's schedule
 *  list mid-day cannot mint a fresh key for a target that already ran. */
export function cronClaimKey(url: URL, target: number, etDate: string): string {
  const params = [...url.searchParams.entries()].filter(([k]) => k !== "etAt").sort(([a], [b]) => a.localeCompare(b));
  const id = params.map(([k, v]) => `${k}=${v}`).join("&");
  return `cron-et-claim:${url.pathname}?${id}:${hhmm(target)}:${etDate}`;
}

/**
 * Call right after requireCronAuth. Returns a 200 "skipped" Response for the off-hour twin, or
 * null to proceed. 200, not an error status: skipping the twin is the designed outcome every day,
 * and a 4xx/5xx would read as a failing cron in the Vercel dashboard. A malformed etAt is a config
 * error and returns 500 — loud, rather than a job that silently never runs.
 *
 * `claimOnce` adds the once-per-ET-day Redis claim. Use it on routes that PLACE ORDERS (trade,
 * drop-check). Leave it off where a second run is harmless or already guarded — the autopilot has
 * its own sent-mark and relies on a retry after a pre-email failure, which a claim taken at the
 * door would block.
 */
export async function requireCronEtWindow(
  request: Request,
  opts: { claimOnce?: boolean; now?: Date; claim?: Claim; alert?: typeof sendAlert } = {},
): Promise<Response | null> {
  const { claimOnce = false, now = new Date(), claim = redisClaim, alert = sendAlert } = opts;
  const url = new URL(request.url);
  const etAt = url.searchParams.get("etAt");
  let decision: ReturnType<typeof cronEtDecision>;
  try {
    decision = cronEtDecision(etAt, now);
  } catch (e) {
    console.error("CRON_ET_GATE_CONFIG_ERROR", { etAt, error: String(e) });
    return Response.json({ error: `cron etAt misconfigured: ${String(e)}` }, { status: 500 });
  }
  if (!decision.run) {
    if (decision.late) {
      console.error("CRON_ET_GATE_LATE_SKIP", { path: url.pathname, etAt, reason: decision.reason });
      await alert(
        `⚠️ Cron skipped — arrived late — ${url.pathname}`,
        `${url.pathname}${url.search}: ${decision.reason}. The job did NOT run. For /api/trade the autopilot `
        + `repair will call it if the autopilot itself ran; otherwise run it by hand WITHOUT the etAt param.`,
      ).catch(() => {});
    } else {
      console.log("CRON_ET_GATE_SKIP", { path: url.pathname, etAt, reason: decision.reason });
    }
    return Response.json({ skipped: true, reason: decision.reason });
  }
  if (decision.target == null || !claimOnce) return null;   // ungated call, or a route that needs no claim
  if (await claim(cronClaimKey(url, decision.target, decision.etDate))) return null;
  const reason = `already ran for ${hhmm(decision.target)} ET on ${decision.etDate} — a second invocation of the same cron entry`;
  console.warn("CRON_ET_GATE_DUPLICATE", { path: url.pathname, etAt, reason });
  return Response.json({ skipped: true, reason });
}
