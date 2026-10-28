"use client";

import React, { useState } from "react";

// Dated strategy updates, shown as tabs so the banner stays one note tall. NEWEST FIRST: the first
// entry is the tab selected on load, so a new update goes at the top of this list.
const em = { color: "#e5e5e5", fontWeight: 600 } as const;
const NOTES: { date: string; label: string; body: React.ReactNode }[] = [
  {
    date: "2026-10-28",
    label: "Buying into earnings",
    body: <>
      The agent used to skip buying any stock reporting earnings within 3 days, in both books. A 2004–2026 backtest found that rule made no difference (+7.34% vs +7.39% a year), so a stock with a strong beat record (at least 4 quarters on record, beating estimates in three-quarters or more of them, by +5% or more on average) may now be bought just before it reports. Every other stock is still skipped, including one whose record we cannot fetch. It is the same bar the agent already used as a reason to keep a holding through its report.
    </>,
  },
  {
    date: "2026-10-26",
    label: "Sector caps",
    body: <>
      Each sector may hold at most 3× its weight in the S&amp;P 500, replacing the flat 40%-per-sector cap. In practice Technology may hold up to 3 names (~60% of the book), Financials and Health Care 2, every other sector 1 (~20%). Big sectors loosen and small ones tighten, so a sector the market barely holds (Energy, ~4%) can no longer become 40% of this book. Buy-side only: it limits new buys and never forces a sale. In a 1999–2026 backtest it beat the flat cap (+11.4% vs +9.0% a year, similar worst drop), but all of that edge came from the tech-led 2013–2026 years; in 1999–2012 it did slightly worse. In effect it is a bet that technology keeps leading.
    </>,
  },
  {
    date: "2026-07-09",
    label: "Quality-momentum",
    body: <>
      The main book switched to a <span style={em}>quality-momentum</span> strategy: rank the S&amp;P 500 by 12-month momentum (skipping the most recent month), keep only above-median-quality names (profitability &amp; low debt, from SEC filings), cap each sector (40% at the time — see the 2026-10-26 tab), and hold ~6 high-conviction names chosen from that shortlist with insider buys, analyst actions, fresh news and sector rotation as tie-breakers. The YouTube-influencer sleeve is unchanged.
    </>,
  },
];

export function StrategyNotes() {
  const [active, setActive] = useState(0);
  const note = NOTES[active];
  return (
    <div style={{ background: "#111", border: "1px solid #222", borderLeft: "3px solid #3b6ea5", borderRadius: 8, padding: "10px 16px 12px", marginBottom: 20, fontSize: 13, lineHeight: 1.6, color: "#bbb" }}>
      <div role="tablist" aria-label="Strategy updates" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ color: "#888", fontSize: 12, marginRight: 4 }}>Strategy updates</span>
        {NOTES.map((n, i) => (
          <button
            key={n.date}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            style={{
              background: i === active ? "#1d2a3a" : "transparent",
              border: `1px solid ${i === active ? "#3b6ea5" : "#2a2a2a"}`,
              color: i === active ? "#e5e5e5" : "#999",
              borderRadius: 6, padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            {n.date.slice(5)} · {n.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <span style={{ color: "#e5e5e5", fontWeight: 700 }}>{note.date} — </span>
        <span style={em}>{note.label}.</span> {note.body}
      </div>
    </div>
  );
}
