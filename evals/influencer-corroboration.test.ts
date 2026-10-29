import { describe, expect, test } from "bun:test";
import { namesMatch, verifyBuyNames, nameKey, buyChannelCounts, sleeveBuyQualifies, MIN_BUY_CHANNELS, extractSignal, formatInfluencerSignals, type InfluencerCache } from "@/lib/influencer-signals";

// 2026-10-29: one video ("If You Missed NVIDIA Stock…") recommended Coherent (COHR); the extractor
// wrote COR (Cencora, a drug distributor); a single high-confidence call scores 3 = the buy floor,
// so the sleeve bought COR. Two independent fixes: the ticker check and the two-channel bar.

describe("namesMatch — deterministic company-name check", () => {
  test("the 10-29 case fails: Coherent is not Cencora", () => {
    expect(namesMatch("Coherent", "Cencora, Inc.")).toBe(false);
  });
  test("same company passes despite suffixes and case", () => {
    expect(namesMatch("Coherent", "Coherent Corp.")).toBe(true);
    expect(namesMatch("Nvidia", "NVIDIA Corporation")).toBe(true);
    expect(namesMatch("Advanced Micro Devices", "Advanced Micro Devices, Inc.")).toBe(true);
  });
  test("look-alikes are NOT a deterministic match — a YES here is final, so it must not be loose", () => {
    // Review 2026-10-29: a first-word or prefix rule matched every one of these.
    for (const [said, official] of [
      ["Meta", "Metallus Inc."], ["Intel", "Intellia Therapeutics, Inc."], ["Arm", "Armstrong World Industries, Inc."],
      ["General Motors", "General Mills, Inc."], ["American Express", "American Airlines Group Inc."],
      ["First Solar", "First Citizens BancShares, Inc."], ["Advanced Micro Devices", "Advanced Drainage Systems, Inc."],
      ["Snow", "Snowflake Inc."], ["United Health", "United Rentals, Inc."],
    ]) expect(namesMatch(said, official)).toBe(false);
  });
  test("a partial name goes to the model too (Palantir vs Palantir Technologies)", () => {
    expect(namesMatch("Palantir", "Palantir Technologies Inc.")).toBe(false);
  });
  test("a brand/rename is NOT a deterministic match (it goes to the model check)", () => {
    expect(namesMatch("Google", "Alphabet Inc.")).toBe(false);
  });
});

describe("verifyBuyNames — fails CLOSED at every step", () => {
  const official: Record<string, string> = { COR: "Cencora, Inc.", COHR: "Coherent Corp.", GOOGL: "Alphabet Inc." };
  const deps = (model: (t: string, s: string, o: string) => Promise<boolean>) =>
    ({ official: async (t: string) => official[t] ?? null, model });
  test("COR said as 'Coherent' is rejected, with the reason naming both companies", async () => {
    const v = await verifyBuyNames([{ ticker: "COR", said: "Coherent" }], null, deps(async () => false));
    const r = v.get(nameKey("COR", "Coherent"))!;
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Cencora");
  });
  test("a rename the model confirms passes", async () => {
    const v = await verifyBuyNames([{ ticker: "GOOGL", said: "Google" }], null, deps(async () => true));
    expect(v.get(nameKey("GOOGL", "Google"))!.ok).toBe(true);
  });
  test("no name given → dropped", async () => {
    const v = await verifyBuyNames([{ ticker: "COHR", said: null }], null, deps(async () => true));
    expect(v.get(nameKey("COHR", null))!.ok).toBe(false);
  });
  test("lookup failed → dropped, and the reason says it was a lookup failure", async () => {
    const v = await verifyBuyNames([{ ticker: "XYZ", said: "Xyz Corp" }], null, deps(async () => true));
    const r = v.get(nameKey("XYZ", "Xyz Corp"))!;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/lookup failed/);
  });
  test("model error on a mismatch → dropped", async () => {
    const v = await verifyBuyNames([{ ticker: "GOOGL", said: "Google" }], null, deps(async () => { throw new Error("529"); }));
    expect(v.get(nameKey("GOOGL", "Google"))!.ok).toBe(false);
  });
  test("CONTROL: the correct ticker passes without the model", async () => {
    let called = false;
    const v = await verifyBuyNames([{ ticker: "COHR", said: "Coherent" }], null, deps(async () => { called = true; return false; }));
    expect(v.get(nameKey("COHR", "Coherent"))!.ok).toBe(true);
    expect(called).toBe(false);
  });
});

describe("the extractor returns the company name as said", () => {
  test("object entries carry names; a bare string carries none", async () => {
    const fake = { messages: { create: async () => ({ content: [{ type: "text", text: 'SIGNAL:{"buy":[{"ticker":"COHR","company":"Coherent"},"VRT"],"confidence":"high","avoid":[],"insight":"x"}' }] }) } } as any;
    const r = await extractSignal(fake, "t", "d", "ch", "transcript");
    expect(r.tickers).toEqual(["COHR", "VRT"]);
    expect(r.buyNames).toEqual({ COHR: "Coherent" });
  });
});

const sig = (channelId: string, tickers: string[], confidence: "high" | "medium" | "low") =>
  ({ channelName: channelId, channelId, videoId: `${channelId}-${tickers.join("")}`, videoTitle: "", videoUrl: "", publishedAt: "", viewCount: 0, tickers, confidence });

describe("two-channel corroboration bar", () => {
  const cache: InfluencerCache = {
    refreshedAt: "2026-10-29T00:00:00Z",
    signals: [sig("A", ["COHR", "AMD"], "high"), sig("A", ["COHR"], "high"), sig("B", ["AMD"], "medium"), sig("C", ["VRT"], "low")],
    tickerCounts: { COHR: 6, AMD: 5 },
  };
  test("two videos from ONE channel count once", () => {
    expect(buyChannelCounts(cache).COHR).toBe(1);
  });
  test("two different channels count twice; low confidence counts nothing", () => {
    const c = buyChannelCounts(cache);
    expect(c.AMD).toBe(2);
    expect(c.VRT ?? 0).toBe(0);
  });
  test("a high net from one channel does NOT qualify; two channels at the floor do", () => {
    expect(sleeveBuyQualifies(6, 1)).toBe(false);
    expect(sleeveBuyQualifies(3, MIN_BUY_CHANNELS)).toBe(true);
    expect(sleeveBuyQualifies(2, 3)).toBe(false);   // control: the net floor still binds
  });
  test("the prompt row marks a one-channel pick NOT BUYABLE", () => {
    const out = formatInfluencerSignals(cache);
    expect(out).toMatch(/AMD[^\n]*2 channels/);
    expect(out).toMatch(/TWO CHANNELS REQUIRED/);
  });
});

describe("the trade route enforces the channel bar in code", () => {
  test("the net-floor guard also checks sleeveBuyQualifies", async () => {
    const src = await Bun.file("app/api/trade/route.ts").text();
    expect(src).toContain("if (!sleeveBuyQualifies(net, ch)) {");
    expect(src).toContain("const ch = influencerChannels[b.symbol] ?? 0;");
  });
});
