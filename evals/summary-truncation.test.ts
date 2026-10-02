import { describe, expect, test } from "bun:test";
import { formatSummaryForEmail, SUMMARY_EMAIL_LIMIT } from "../lib/run-store";

// Two defects this guards, both of which SILENTLY deleted the model's reasoning from the 8am email:
//  1. `slice(0, 800)` cut the BUY/influencer reasoning (it prints after the main-book review) with
//     no marker — the 2026-10-02 email ended mid-word at "- No h" and never showed why AVGO beat MU.
//  2. The summary was interpolated into email HTML UNESCAPED, so a `<` in model prose makes the mail
//     client swallow everything up to the section's own `</p>`.
describe("formatSummaryForEmail", () => {
  test("a summary within the limit and free of HTML chars is returned byte-identical", () => {
    const s = "## Analysis\n### Influencer sleeve\nBought AVGO over MU: one slot free.";
    expect(formatSummaryForEmail(s)).toBe(s);
  });

  test("a summary exactly at the limit is NOT truncated (boundary is inclusive)", () => {
    const s = "x".repeat(SUMMARY_EMAIL_LIMIT);
    expect(formatSummaryForEmail(s)).toBe(s);
  });

  test("an over-limit summary ANNOUNCES the cut rather than stopping silently", () => {
    const out = formatSummaryForEmail("y".repeat(SUMMARY_EMAIL_LIMIT + 250));
    expect(out).toContain("truncated 250 of");
    expect(out).toContain("dashboard");
  });

  // The HTML-swallowing bug, in the exact shape the model actually writes.
  test("a bare `<` in model prose is escaped, so the rest of the reasoning survives", () => {
    const out = formatSummaryForEmail("Trimmed MU: P/E <18 but momentum broke");
    expect(out).toBe("Trimmed MU: P/E &lt;18 but momentum broke");
    expect(out).not.toContain("<18");
  });

  test("`&` is escaped FIRST, so escapes are not themselves re-escaped", () => {
    expect(formatSummaryForEmail("S&P 500 <rotation>")).toBe("S&amp;P 500 &lt;rotation&gt;");
    expect(formatSummaryForEmail("a & b")).not.toContain("&amp;amp;");
  });

  test("escaping happens AFTER truncation, so the cut cannot land inside an entity", () => {
    // 3 chars of limit, then "<" would be entity-expanded if escaped first.
    const out = formatSummaryForEmail("abc<def", 3);
    expect(out.startsWith("abc")).toBe(true);
    expect(out).not.toContain("&l;");
    expect(out).not.toContain("&amp");
  });

  test("the dropped-char count is measured on RAW text, not escaped text", () => {
    // 4 raw chars over a limit of 6; escaping would inflate "&" to 5 chars and corrupt the count.
    const out = formatSummaryForEmail("abcdef&&&&", 6);
    expect(out).toContain("truncated 4 of 10");
  });

  test("the limit is large enough to reach the buy reasoning, not just the hold review", () => {
    // The real 2026-10-02 main-book review (hold/sell checks only) ran past 800 chars by itself,
    // so any limit at or below that drops the buy reasoning by construction.
    expect(SUMMARY_EMAIL_LIMIT).toBeGreaterThan(800);
    expect(SUMMARY_EMAIL_LIMIT).toBeGreaterThanOrEqual(4000);
  });

  test("a realistic full run summary survives intact", () => {
    const holdReview = Array.from({ length: 12 }, (_, i) => `- SYM${i}: +1.0% ✓ (minor, ◆HELD)`).join("\n");
    const summary = `## Analysis\n### Main Book — Risk Sell Review\n${holdReview}\n\n### Influencer Sleeve\nMU (6) vs AVGO (4): one slot free; chose AVGO on the chip-lease catalyst.`;
    expect(formatSummaryForEmail(summary)).toBe(summary);
    expect(formatSummaryForEmail(summary)).toContain("chose AVGO");
  });
});
