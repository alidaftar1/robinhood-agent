import { SP500_UNIVERSE } from "./strategy";

const INSIDER_CACHE_KEY = "robinhood:insider";
const CACHE_TTL_SECONDS = 48 * 60 * 60; // 48h — covers weekends

async function cacheGet(): Promise<Record<string, InsiderBuy[]> | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${INSIDER_CACHE_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json() as { result: string | null };
    if (!json.result) return null;
    return JSON.parse(json.result) as Record<string, InsiderBuy[]>;
  } catch {
    return null;
  }
}

async function cacheSet(data: Record<string, InsiderBuy[]>): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", INSIDER_CACHE_KEY, JSON.stringify(data), "EX", CACHE_TTL_SECONDS]),
    });
  } catch { /* ignore */ }
}

export interface InsiderBuy {
  ownerName: string;
  ownerTitle: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  filingDate: string;
}

const UA = "RobinhoodAgent/1.0 alidaftar@gmail.com";

async function getCIKMap(signal: AbortSignal): Promise<Map<string, string>> {
  try {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": UA },
      signal,
    });
    if (!res.ok) return new Map();
    const data = await res.json() as Record<string, { cik_str: number; ticker: string }>;
    const symbolSet = new Set(SP500_UNIVERSE.map((s) => s.toUpperCase()));
    const map = new Map<string, string>();
    for (const entry of Object.values(data)) {
      if (symbolSet.has(entry.ticker.toUpperCase())) {
        map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

interface Form4Ref {
  accessionNumber: string;
  filingDate: string;
  primaryDocument: string;
}

async function getRecentForm4s(cik: string, since: Date, signal: AbortSignal): Promise<Form4Ref[]> {
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "User-Agent": UA },
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      filings?: {
        recent?: {
          form: string[];
          filingDate: string[];
          accessionNumber: string[];
          primaryDocument: string[];
        };
      };
    };
    const r = data.filings?.recent;
    if (!r) return [];
    const results: Form4Ref[] = [];
    for (let i = 0; i < r.form.length; i++) {
      if (r.form[i] === "4" && new Date(r.filingDate[i]) >= since) {
        results.push({
          accessionNumber: r.accessionNumber[i],
          filingDate: r.filingDate[i],
          primaryDocument: r.primaryDocument[i],
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function parsePurchases(xml: string, filingDate: string): InsiderBuy[] {
  const isOfficer = /<isOfficer>\s*1\s*<\/isOfficer>/.test(xml);
  const isDirector = /<isDirector>\s*1\s*<\/isDirector>/.test(xml);
  if (!isOfficer && !isDirector) return [];

  const ownerName = xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/)?.[1]?.trim() ?? "Unknown";
  const ownerTitle =
    xml.match(/<officerTitle>([^<]+)<\/officerTitle>/)?.[1]?.trim() ??
    (isDirector ? "Director" : "Insider");

  const buys: InsiderBuy[] = [];
  const blockRe = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const b = m[1];
    if (!/<transactionCode>\s*P\s*<\/transactionCode>/.test(b)) continue;
    const shares = parseFloat(
      b.match(/<transactionShares>[\s\S]*?<value>([\d.]+)<\/value>/)?.[1] ?? "0"
    );
    const price = parseFloat(
      b.match(/<transactionPricePerShare>[\s\S]*?<value>([\d.]+)<\/value>/)?.[1] ?? "0"
    );
    if (shares > 0 && price > 0) {
      buys.push({ ownerName, ownerTitle, shares, pricePerShare: price, totalValue: shares * price, filingDate });
    }
  }
  return buys;
}

async function fetchForm4(
  cik: string,
  accessionNumber: string,
  primaryDocument: string,
  signal: AbortSignal
): Promise<string | null> {
  try {
    const cikNum = parseInt(cik).toString();
    const accNo = accessionNumber.replace(/-/g, "");
    const doc = primaryDocument.replace(/^xslF345X06\//, ""); // strip XSLT prefix — that path returns HTML, not XML
    const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNo}/${doc}`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

async function _fetch(signal: AbortSignal): Promise<Record<string, InsiderBuy[]>> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const cikMap = await getCIKMap(signal);
  if (cikMap.size === 0) return {};

  const subResults = await Promise.allSettled(
    [...cikMap.entries()].map(([symbol, cik]) =>
      getRecentForm4s(cik, since, signal).then((refs) => ({ symbol, cik, refs }))
    )
  );

  const toFetch: Array<{ symbol: string; cik: string } & Form4Ref> = [];
  for (const r of subResults) {
    if (r.status === "fulfilled") {
      for (const ref of r.value.refs) {
        toFetch.push({ symbol: r.value.symbol, cik: r.value.cik, ...ref });
      }
    }
  }

  if (toFetch.length === 0) return {};

  const result: Record<string, InsiderBuy[]> = {};
  const docResults = await Promise.allSettled(
    toFetch.map(async ({ symbol, cik, accessionNumber, filingDate, primaryDocument }) => {
      const content = await fetchForm4(cik, accessionNumber, primaryDocument, signal);
      if (!content) return null;
      const buys = parsePurchases(content, filingDate);
      return buys.length > 0 ? { symbol, buys } : null;
    })
  );

  for (const r of docResults) {
    if (r.status === "fulfilled" && r.value) {
      const { symbol, buys } = r.value;
      result[symbol] = [...(result[symbol] ?? []), ...buys];
    }
  }

  return result;
}

// Reads insider data from Upstash cache (populated by /api/insider cron)
export async function getInsiderBuys(): Promise<Record<string, InsiderBuy[]>> {
  return (await cacheGet()) ?? {};
}

// Called by /api/insider cron — fetches from EDGAR and writes to cache
export async function refreshInsiderCache(): Promise<Record<string, InsiderBuy[]>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000); // 4 min — leaves buffer within 300s maxDuration
  try {
    const data = await _fetch(controller.signal);
    await cacheSet(data);
    return data;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
