import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionCookieConfig, touchSession } from "@/lib/dashboard-auth";
import { getGivebackShadow } from "@/lib/giveback-shadow";
import { getMeanRevShadow } from "@/lib/mean-reversion";
import { scoreShadowObservations, type ShadowStats } from "@/lib/shadow-scoring";
import { getFeatureCaptureStatus, type CaptureStatus } from "@/lib/feature-capture";

// Read-only observability for the measure-first captures. Everything here already existed behind
// CRON_SECRET, which meant reading it required a terminal and handling the cron secret by hand —
// so in practice it was never read. This surfaces it behind the SAME session gate as the main
// dashboard: no new auth path, no new secret, and CRON_SECRET is not weakened or reused.
//
// Server component on purpose. It calls the lib functions directly, so there is no new API route
// and nothing new to authorise; the page is the authorisation boundary, exactly as `/` is.
//
// Nothing here writes. No capture, ledger, or run record is mutated by loading this page.

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
            </p>
          ) : (
            <p style={{ color: "#8b949e", fontSize: 12, marginTop: 10 }}>
              No weekday gaps in the last 30 days. Market holidays show as gaps here and are expected.
            </p>
          )}
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

  // allSettled, not all: one unreachable capture must not blank the whole page. Each card reports
  // its own failure — a page that renders nothing teaches you to stop opening it.
  const [giveback, meanrev, capture] = await Promise.allSettled([
    getGivebackShadow().then(days =>
      scoreShadowObservations(
        (days ?? []).flatMap(d => (d.holdings ?? []).map(h => ({ symbol: h.symbol, price: h.price, date: d.date }))),
        today, "exit",
      )),
    getMeanRevShadow().then(days =>
      scoreShadowObservations(
        (days ?? []).flatMap(d => (d.candidates ?? []).map(c => ({ symbol: c.symbol, price: c.price, date: d.date }))),
        today, "entry",
      )),
    getFeatureCaptureStatus(today),
  ]);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui", color: "#c9d1d9", background: "#0d1117", minHeight: "100vh" }}>
      <Link href="/" style={{ color: "#58a6ff", fontSize: 13 }}>← Dashboard</Link>
      <h1 style={{ fontSize: 22, margin: "12px 0 4px" }}>Observability</h1>
      <p style={{ color: "#8b949e", fontSize: 13, marginTop: 0 }}>
        Zero-capital captures. Nothing here trades, and nothing here is written by opening the page.
      </p>

      <CaptureCard
        status={capture.status === "fulfilled" ? capture.value : null}
        error={reason(capture)}
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
