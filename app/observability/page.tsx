import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionCookieConfig, touchSession } from "@/lib/dashboard-auth";
import { getGivebackShadowOrNull } from "@/lib/giveback-shadow";
import { getMeanRevShadowOrNull } from "@/lib/mean-reversion";
import { scoreShadowObservations, type ShadowStats } from "@/lib/shadow-scoring";
import { getFeatureCaptureStatus, type CaptureStatus } from "@/lib/feature-capture";
import { replayAllVariants, type ReplayAllResult, type VariantReplayResult } from "@/lib/variant-replay";
import { VARIANTS, BASELINE_VARIANT_ID } from "@/lib/strategy-variant";

// Read-only observability for the measure-first captures. Everything here already existed behind
// CRON_SECRET, which meant reading it required a terminal and handling the cron secret by hand —
// so in practice it was never read. This surfaces it behind the SAME session gate as the main
// dashboard: no new auth path, no new secret, and CRON_SECRET is not weakened or reused.
//
// Server component on purpose. It calls the lib functions directly, so there is no new API route
// and nothing new to authorise; the page is the authorisation boundary, exactly as `/` is.
//
// No CAPTURED DATA is mutated by loading this page — no shadow, ledger, or run record is written.
// The one write that does happen is touchSession's EXPIRE, which refreshes the session TTL exactly
// as the main dashboard does; that is session bookkeeping, not data mutation. Stating it precisely
// because "nothing here writes" is the kind of claim that is easy to make and wrong.

export const dynamic = "force-dynamic";

const pct = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "4px 0" }}>
      <span style={{ color: "#8b949e" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {value}
        {hint ? <span style={{ color: "#8b949e", fontSize: 12 }}> {hint}</span> : null}
      </span>
    </div>
  );
}

function ShadowCard({ title, subtitle, stats, error }: {
  title: string; subtitle: string; stats: ShadowStats | null; error?: string;
}) {
  return (
    <section style={{ border: "1px solid #30363d", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>{title}</h2>
      <p style={{ margin: "0 0 12px", color: "#8b949e", fontSize: 13 }}>{subtitle}</p>
      {error ? (
        <p style={{ color: "#f85149", fontSize: 13 }}>Could not load: {error}</p>
      ) : !stats || stats.symbolsScored === 0 ? (
        // An unscored capture is the NORMAL early state, not a failure — say which it is rather
        // than rendering zeros that read as "the signal is worthless".
        <p style={{ color: "#d29922", fontSize: 13 }}>
          Capturing, nothing scoreable yet — {stats?.observations ?? 0} rows across{" "}
          {stats?.distinctSymbols ?? 0} names, {stats?.matured ?? 0} old enough to have a forward
          window. This is expected until observations mature.
        </p>
      ) : (
        <>
          <StatRow label="Verdict" value={stats.verdict} />
          <StatRow label="Hit rate" value={`${stats.hitRatePct.toFixed(0)}%`}
            hint={`of ${stats.symbolsScored} names`} />
          <StatRow label="Avg forward return" value={pct(stats.avgForwardReturnPct)} />
          <StatRow label="vs SPY" value={pct(stats.avgExcessReturnPct)}
            hint={stats.avgSpyReturnPct == null ? "(no benchmark)" : `SPY ${pct(stats.avgSpyReturnPct)}`} />
          <StatRow label="Sample" value={`${stats.observations} rows / ${stats.distinctSymbols} names`}
            hint={`${stats.matured} matured`} />
          <p style={{ margin: "10px 0 0", color: "#8b949e", fontSize: 12, lineHeight: 1.5 }}>
            Scored one vote per NAME, not per row — the same name recurs across days, so a row count
            would overstate the evidence. Treat a few dozen names as suggestive, not conclusive.
          </p>
        </>
      )}
    </section>
  );
}

function CaptureCard({ status, error }: { status: CaptureStatus | null; error?: string }) {
  const mb = status ? (status.totalBytes / 1024 / 1024).toFixed(1) : "—";
  const stalled = status != null && status.missingRecentWeekdays.length > 0;
  return (
    <section style={{ border: "1px solid #30363d", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>Feature capture (Phase 0)</h2>
      <p style={{ margin: "0 0 12px", color: "#8b949e", fontSize: 13 }}>
        The per-name feature vector the run used to discard. Cannot be backfilled, so the only
        thing that matters here is whether it is still writing.
      </p>
      {error ? (
        <p style={{ color: "#f85149", fontSize: 13 }}>Could not load: {error}</p>
      ) : (
        <>
          <StatRow label="Last capture" value={status?.lastCapture ?? "never"} />
          <StatRow label="Days stored (30d window)" value={String(status?.days.length ?? 0)} />
          <StatRow label="Total size" value={`${mb} MB`} />
          {stalled ? (
            <p style={{ color: "#f85149", fontSize: 13, marginTop: 10 }}>
              Missing on {status!.missingRecentWeekdays.length} recent weekday(s):{" "}
              {status!.missingRecentWeekdays.slice(0, 5).join(", ")}
              {status!.missingRecentWeekdays.length > 5 ? " …" : ""}. A stalled capture has no other
              symptom — it simply produces a thinner dataset than anyone expects later.
              Weekends, market holidays, today, and days before the first capture are already
              excluded, so these are real misses.
            </p>
          ) : (
            <p style={{ color: "#8b949e", fontSize: 12, marginTop: 10 }}>
              No missing trading days in the last 30. Weekends, market holidays, and today are
              excluded — today's capture lands with the 14:30 UTC run.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function VariantRow({ v, baselineExcess }: { v: VariantReplayResult; baselineExcess: number | null }) {
  const oos = v.outOfSample.stats;
  const isBaseline = v.id === BASELINE_VARIANT_ID;
  // Only ever compared on OUT-OF-SAMPLE, and only when BOTH sides have a real benchmark. A missing
  // SPY reference must not read as "matched the baseline".
  const delta = !isBaseline && oos?.avgExcessReturnPct != null && baselineExcess != null
    ? oos.avgExcessReturnPct - baselineExcess
    : null;
  return (
    <div style={{ borderTop: "1px solid #21262d", padding: "12px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span style={{ fontWeight: 600 }}>
          {v.id}{isBaseline ? <span style={{ color: "#8b949e", fontWeight: 400 }}> — baseline</span> : null}
        </span>
        <span style={{ color: "#8b949e", fontSize: 12 }}>registered {v.registeredAt}</span>
      </div>
      <p style={{ margin: "4px 0 8px", color: "#8b949e", fontSize: 12, lineHeight: 1.5 }}>{v.description}</p>
      <StatRow
        label="Out-of-sample vs SPY"
        value={oos && oos.symbolsScored > 0 ? pct(oos.avgExcessReturnPct) : "—"}
        hint={oos && oos.symbolsScored > 0
          ? `${oos.symbolsScored} names · ${oos.hitRatePct.toFixed(0)}% hit · ${v.outOfSample.days}d`
          : `${v.outOfSample.days} day(s) captured, nothing matured yet`}
      />
      {delta != null ? (
        <StatRow label="vs baseline (out-of-sample)" value={pct(delta)} />
      ) : null}
      <StatRow
        label="In-sample (cannot promote)"
        value={v.inSample.stats && v.inSample.stats.symbolsScored > 0 ? pct(v.inSample.stats.avgExcessReturnPct) : "—"}
        hint={`${v.inSample.days}d before registration`}
      />
      {v.promotion ? (
        <p style={{
          margin: "8px 0 0", fontSize: 12, lineHeight: 1.5,
          color: v.promotion.eligible ? "#3fb950" : "#8b949e",
        }}>
          {v.promotion.eligible ? "✓ " : "· "}{v.promotion.reasons.join("; ")}
        </p>
      ) : (
        <p style={{ margin: "8px 0 0", color: "#d29922", fontSize: 12 }}>
          Not yet judgeable — no out-of-sample name has a forward window.
        </p>
      )}
      {v.excludedDays.length > 0 ? (
        <p style={{ margin: "6px 0 0", color: "#8b949e", fontSize: 11 }}>
          {v.excludedDays.length} day(s) excluded: {v.excludedDays.slice(0, 2).map(d => `${d.date} (${d.reason})`).join("; ")}
          {v.excludedDays.length > 2 ? " …" : ""}
        </p>
      ) : null}
    </div>
  );
}

function VariantsCard({ result, error }: { result: ReplayAllResult | null; error?: string }) {
  const baseline = result?.variants.find(v => v.id === BASELINE_VARIANT_ID);
  const baselineExcess = baseline?.outOfSample.stats?.avgExcessReturnPct ?? null;
  return (
    <section style={{ border: "1px solid #30363d", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>Strategy variants (Tier 0)</h2>
      <p style={{ margin: "0 0 12px", color: "#8b949e", fontSize: 13, lineHeight: 1.5 }}>
        Zero-capital strategy candidates, replayed over the stored point-in-time feature capture and
        scored against SPY. Variants are pure functions over captured features — they cannot place an
        order, write a return, or deploy. Every one is compared to the <em>same</em> baseline on the
        same days and the same caps.
      </p>
      {error ? (
        <p style={{ color: "#f85149", fontSize: 13 }}>Could not load: {error}</p>
      ) : !result || result.captureDays === 0 ? (
        <p style={{ color: "#d29922", fontSize: 13 }}>
          No capture days readable yet — the feature capture began 2026-09-29 and grows by one
          trading day at a time. Replay depth is the binding constraint on this whole tier.
        </p>
      ) : (
        <>
          <StatRow label="Capture days replayed" value={String(result.captureDays)}
            hint={`${result.windowDays}d window`} />
          {result.variants.map(v => (
            <VariantRow key={v.id} v={v} baselineExcess={baselineExcess} />
          ))}
          <p style={{ margin: "12px 0 0", color: "#8b949e", fontSize: 12, lineHeight: 1.5 }}>
            <strong>In-sample can only disqualify, never promote.</strong> Because picks are recomputed
            on read, a variant written today can be replayed over days that already happened — the
            look-ahead that makes backtests lie. Promotion is judged on out-of-sample only, and even
            then it names a Tier 1 <em>candidate</em>: forward evidence kills a bad variant fast and
            confirms a good one slowly (an information ratio of 0.5 needs ~16 years to establish at
            95% confidence).
          </p>
        </>
      )}
    </section>
  );
}

export default async function ObservabilityPage() {
  const sessionId = (await cookies()).get(getSessionCookieConfig().name)?.value;
  const authed = sessionId ? await touchSession(sessionId) : false;
  // Redirect rather than render LoginScreen here: its form GETs to the CURRENT path, and the
  // middleware only redeems a credential on "/" (deliberately — it is guarded by pathname so the
  // matcher can cover /public without changing it). Logging in from this page would therefore
  // dead-end. Sending unauthenticated visitors to "/" keeps the credential surface exactly as it
  // is rather than widening it for a read-only view.
  if (!authed) redirect("/");

  const today = new Date().toISOString().slice(0, 10);
  const reason = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : undefined;

  // Scoring fans out one live quote per DISTINCT symbol in sequential batches, so cost grows with
  // the capture. Bound it two ways: only score the most recent window, and give each card a hard
  // deadline. Without the deadline a slow quote source kills the whole function before
  // allSettled can report anything — the per-card error state would be bypassed exactly when it
  // is needed, and the visitor would get a 504 instead of a diagnosis.
  const SCORE_WINDOW_DAYS = 60;
  const DEADLINE_MS = 8_000;
  const withDeadline = <T,>(p: Promise<T>, label: string, ms: number = DEADLINE_MS): Promise<T> =>
    Promise.race([p, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000}s`)), ms))]);
  const recent = <T extends { date: string }>(days: T[]) => days.slice(-SCORE_WINDOW_DAYS);

  // allSettled, not all: one unreachable capture must not blank the whole page. Each card reports
  // its own failure — a page that renders nothing teaches you to stop opening it.
  const [giveback, meanrev, capture, variants] = await Promise.allSettled([
    withDeadline(getGivebackShadowOrNull().then(days => {
      if (days === null) throw new Error("capture unreadable (Upstash)");
      return scoreShadowObservations(
        recent(days).flatMap(d => (d.holdings ?? []).map(h => ({ symbol: h.symbol, price: h.price, date: d.date }))),
        today, "exit",
      );
    }), "give-back scoring"),
    withDeadline(getMeanRevShadowOrNull().then(days => {
      if (days === null) throw new Error("capture unreadable (Upstash)");
      return scoreShadowObservations(
        recent(days).flatMap(d => (d.candidates ?? []).map(c => ({ symbol: c.symbol, price: c.price, date: d.date }))),
        today, "entry",
      );
    }), "mean-reversion scoring"),
    withDeadline(getFeatureCaptureStatus(today), "capture health"),
    // Longer deadline than the cards above: this replays every variant and scores each one's picks,
    // which costs a live quote per distinct symbol per variant. Still bounded, and still fails into
    // its own card rather than taking the page down.
    withDeadline(replayAllVariants(VARIANTS, today), "variant replay", 20_000),
  ]);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui", color: "#c9d1d9", background: "#0d1117", minHeight: "100vh" }}>
      <Link href="/" style={{ color: "#58a6ff", fontSize: 13 }}>← Dashboard</Link>
      <h1 style={{ fontSize: 22, margin: "12px 0 4px" }}>Observability</h1>
      <p style={{ color: "#8b949e", fontSize: 13, marginTop: 0 }}>
        Zero-capital captures. Nothing here trades, and opening this page does not alter any capture.
      </p>

      <CaptureCard
        status={capture.status === "fulfilled" ? capture.value : null}
        error={reason(capture)}
      />

      <VariantsCard
        result={variants.status === "fulfilled" ? variants.value : null}
        error={reason(variants)}
      />

      <ShadowCard
        title="Give-back stop (exit signal)"
        subtitle="Holdings already down ≥5% over 5 days — did they keep falling? Right when the name kept falling relative to SPY."
        stats={giveback.status === "fulfilled" ? giveback.value.stats : null}
        error={reason(giveback)}
      />

      <ShadowCard
        title="Mean reversion (entry signal)"
        subtitle="Oversold quality names — did they bounce? Right when the name ROSE relative to SPY. Scores the OPPOSITE way to the give-back card."
        stats={meanrev.status === "fulfilled" ? meanrev.value.stats : null}
        error={reason(meanrev)}
      />

      <p style={{ color: "#8b949e", fontSize: 12, lineHeight: 1.6 }}>
        These two bracket the same question from opposite ends: whether a drawdown persists or
        reverses. If oversold names reliably keep falling, drawdown has exploitable structure; if
        they bounce, the fall was noise. That is the question
        {" "}<code style={{ color: "#c9d1d9" }}>docs/experiment-nori-tail-risk.md</code>{" "}
        exists to answer, and these captures are the early, free read on it.
      </p>
    </main>
  );
}
