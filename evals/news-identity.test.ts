import { describe, expect, test } from "bun:test";
import { extractMaterialNews, isAboutOtherCompany, isPriceRecap, FAILED } from "../lib/news";

// 2026-11-03: Finnhub served "Merck to Divest CDMO Business to Lonza" under MRK (Merck & Co.). It
// was Merck KGaA of Darmstadt, Germany. The extractor saw only "MRK headlines", tagged it ⚡NEWS↓,
// and the run sold MRK on it. These pin the fix without a model call: a scripted fake replies.

type Reply = string | Error;
function fake(replies: Reply[]) {
  const calls: Array<{ system: string; content: string; max_tokens?: number }> = [];
  return {
    calls,
    client: { messages: { create: async (p: any) => {
      calls.push({ system: p.system, content: p.messages[0].content, max_tokens: p.max_tokens });
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { content: [{ type: "text", text: r ?? "" }] };
    } } } as any,
  };
}

const lonza = { headline: "Merck to Divest CDMO Business to Lonza", date: "2026-11-03", summary: "Darmstadt, Germany, Nov. 03, 2026 (GLOBE NEWSWIRE) -- Lonza to acquire the CDMO business of Merck" };
const event = 'NEWS:{"material":true,"direction":"-","summary":"Merck to divest CDMO business to Lonza","date":"2026-11-03","n":1}';

describe("news: an event about a different company with the same name is dropped", () => {
  test("identity check says OTHER → no event (the 11-03 MRK case)", async () => {
    const f = fake([event, "OTHER"]);
    expect(await extractMaterialNews(f.client, "MRK", [lonza], "Merck & Co Inc")).toBeNull();
    // the check sees the SUMMARY (where "Darmstadt, Germany" is) and the company name
    expect(f.calls[1].content).toContain("Darmstadt, Germany");
    expect(f.calls[1].system).toContain("Merck & Co Inc (MRK)");
  });

  test("identity check says SAME → event kept", async () => {
    const f = fake([event, "SAME"]);
    expect(await extractMaterialNews(f.client, "MRK", [lonza], "Merck & Co Inc")).toMatchObject({ direction: "-" });
  });

  test("UNSURE keeps the event — only a clear OTHER drops one", async () => {
    expect(await extractMaterialNews(fake([event, "UNSURE"]).client, "MRK", [lonza], "Merck & Co Inc")).not.toBeNull();
  });

  test("identity check fails → event kept (the behaviour before the check existed)", async () => {
    expect(await extractMaterialNews(fake([event, new Error("529")]).client, "MRK", [lonza], "Merck & Co Inc")).not.toBeNull();
  });

  test("no usable headline number → no identity check, event kept", async () => {
    const f = fake([event.replace('"n":1', '"n":9')]);
    expect(await extractMaterialNews(f.client, "MRK", [lonza], "Merck & Co Inc")).not.toBeNull();
    expect(f.calls.length).toBe(1);
  });

  test("the extractor prompt names the company and judges from headlines only (no summaries)", async () => {
    const f = fake(['NEWS:{"material":false,"direction":"0","summary":"","date":""}']);
    await extractMaterialNews(f.client, "MRK", [lonza], "Merck & Co Inc");
    expect(f.calls[0].system).toContain("Merck & Co Inc (US ticker MRK)");
    expect(f.calls[0].content).not.toContain("Darmstadt");   // summaries made it flag price recaps
  });

  test("a rejection without the NEWS: prefix parses as 'no event', not as a failure", async () => {
    const f = fake(['{"material":false,"direction":"0","summary":"","date":""}\n\nThis is Merck KGaA, not Merck & Co.']);
    expect(await extractMaterialNews(f.client, "MRK", [lonza], "Merck & Co Inc")).toBeNull();
  });

  test("garbage is still a failure (never cached as 'no news')", async () => {
    expect(await extractMaterialNews(fake(["I cannot help with that."]).client, "MRK", [lonza], null)).toBe(FAILED);
  });

  test("isAboutOtherCompany: only a leading OTHER counts", async () => {
    expect(await isAboutOtherCompany(fake(["OTHER"]).client, "MRK", null, lonza)).toBe(true);
    expect(await isAboutOtherCompany(fake(["SAME — not other"]).client, "MRK", null, lonza)).toBe(false);
    expect(await isAboutOtherCompany(fake([new Error("x")]).client, "MRK", null, lonza)).toBe(false);
  });
});

// 2026-11-04: a multi-company movers recap ("…Merck Slides 2% Amid New Phase 3 Trial") became MRK
// ⚡NEWS↓. A bearish event now gets a third look at its source item: price recap, or real event?
const recapItem = { headline: "Moderna Climbs 5% Ahead of Earnings, Pfizer Eases Despite Raised Outlook, Merck Slides 2% Amid New Phase 3 Trial", date: "2026-11-03", summary: "Moderna surges on pre-earnings momentum, Pfizer dips after beating estimates" };
const bearish = 'NEWS:{"material":true,"direction":"-","summary":"Merck slides 2% amid new Phase 3 trial results","date":"2026-11-03","n":1}';
const bullish = 'NEWS:{"material":true,"direction":"+","summary":"Merck wins approval","date":"2026-11-03","n":1}';

describe("news: a bearish event that is only a price-move recap is dropped", () => {
  test("identity SAME, recap check RECAP → no event", async () => {
    const f = fake([bearish, "SAME", "RECAP"]);
    expect(await extractMaterialNews(f.client, "MRK", [recapItem], "Merck & Co Inc")).toBeNull();
    expect(f.calls.length).toBe(3);
    expect(f.calls[2].content).toContain("Merck Slides 2%");
    expect(f.calls[2].system).toContain("Merck & Co Inc (MRK)");
  });

  test("EVENT, UNSURE or an error keeps the bearish event — only a clear RECAP drops one", async () => {
    for (const third of ["EVENT", "UNSURE", new Error("529")] as Reply[]) {
      expect(await extractMaterialNews(fake([bearish, "SAME", third]).client, "MRK", [recapItem], "Merck & Co Inc")).toMatchObject({ direction: "-" });
    }
  });

  test("a bullish event is not sent to the recap check", async () => {
    const f = fake([bullish, "SAME", "RECAP"]);
    expect(await extractMaterialNews(f.client, "MRK", [recapItem], "Merck & Co Inc")).toMatchObject({ direction: "+" });
    expect(f.calls.length).toBe(2);
  });

  test("an OTHER-company verdict short-circuits before the recap check", async () => {
    const f = fake([bearish, "OTHER", "EVENT"]);
    expect(await extractMaterialNews(f.client, "MRK", [recapItem], "Merck & Co Inc")).toBeNull();
    expect(f.calls.length).toBe(2);
  });

  test("isPriceRecap: only a leading RECAP counts", async () => {
    expect(await isPriceRecap(fake(["RECAP"]).client, "MRK", null, recapItem)).toBe(true);
    expect(await isPriceRecap(fake(["EVENT — not a recap"]).client, "MRK", null, recapItem)).toBe(false);
    expect(await isPriceRecap(fake([new Error("x")]).client, "MRK", null, recapItem)).toBe(false);
  });

  test("the extractor asks for the NEWS: line first and has room to finish (SNDK ran out at 200)", async () => {
    const f = fake(['NEWS:{"material":false,"direction":"0","summary":"","date":""}']);
    await extractMaterialNews(f.client, "SNDK", [recapItem], "SanDisk Corporation");
    expect(f.calls[0].system).toContain("START your reply with the NEWS: line");
    expect(f.calls[0].max_tokens).toBeGreaterThanOrEqual(400);
  });
});
