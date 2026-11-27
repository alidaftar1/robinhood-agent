import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Never write test rows into the production meter, whatever env this runs with.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const { meterAnthropic, summarizeUsage, usageFields, daysBefore, usageDatesSince } = await import("@/lib/llm-usage");

describe("token meter", () => {
  test("one response → counted fields; junk usage counts zero, never NaN", () => {
    expect(usageFields("trade", "claude-sonnet-4-6", { input_tokens: 18000, output_tokens: 3200, cache_read_input_tokens: null }))
      .toEqual([["trade|claude-sonnet-4-6|calls", 1], ["trade|claude-sonnet-4-6|in", 18000], ["trade|claude-sonnet-4-6|out", 3200],
        ["trade|claude-sonnet-4-6|cacheRead", 0], ["trade|claude-sonnet-4-6|cacheWrite", 0]]);
    expect(usageFields("a|b", "m", { input_tokens: NaN as any }).map(x => x[1])).toEqual([1, 0, 0, 0, 0]);
    expect(usageFields("a|b", "m", undefined)[0][0]).toBe("a/b|m|calls");
  });

  test("cost: Sonnet $3/$15, Haiku $1/$5 per M; cache read 0.1x, write 1.25x; unknown model → null", () => {
    const rows = summarizeUsage({
      "trade|claude-sonnet-4-6|calls": "1", "trade|claude-sonnet-4-6|in": "1000000", "trade|claude-sonnet-4-6|out": "100000",
      "news-reader|claude-haiku-4-5-20251001|in": "1000000", "news-reader|claude-haiku-4-5-20251001|cacheRead": "1000000",
      "x|mystery-model|in": "5",
    });
    const by = Object.fromEntries(rows.map(r => [r.label, r.costUsd]));
    expect(by.trade).toBeCloseTo(4.5, 6);
    expect(by["news-reader"]).toBeCloseTo(1.1, 6);
    expect(by.x).toBeNull();
  });

  test("the caller gets the SDK's own promise back (helpers kept), and metering never throws", async () => {
    const resp = { model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 2 }, content: [] };
    const sdkPromise = Object.assign(Promise.resolve(resp), { withResponse: () => "kept" });
    const client = { messages: { create: () => sdkPromise }, beta: { messages: { create: () => sdkPromise } }, other: 7 };
    const m = meterAnthropic(client, "test");
    const p = m.messages.create();
    expect(p).toBe(sdkPromise);
    expect((p as any).withResponse()).toBe("kept");
    expect(await p).toBe(resp);
    expect(await (m as any).beta.messages.create()).toBe(resp);
    expect((m as any).other).toBe(7);
  });

  test("an API error still reaches the caller unchanged", async () => {
    const m = meterAnthropic({ messages: { create: () => Promise.reject(new Error("429")) } }, "t");
    await expect(m.messages.create()).rejects.toThrow("429");
  });

  test("dates step by calendar day (no DST repeat); Monday reports Friday to Sunday", () => {
    expect(daysBefore("2026-11-02", 1)).toBe("2026-11-01");
    expect(daysBefore("2026-11-02", 2)).toBe("2026-10-31");
    expect(usageDatesSince("2026-11-30")).toEqual(["2026-11-27", "2026-11-28", "2026-11-29"]); // Monday
    expect(usageDatesSince("2026-11-27")).toEqual(["2026-11-26"]);                             // Friday
  });

  test("no production code creates an unlabelled client", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
    const root = join(import.meta.dir, "..");
    const offenders = [...walk(join(root, "app")), ...walk(join(root, "lib"))]
      .filter(f => readFileSync(f, "utf8").includes("createAnthropic()"));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(root, "lib/anthropic.ts"), "utf8")).toContain("return meterAnthropic(Sentry.instrumentAnthropicAiClient(");
  });
});
