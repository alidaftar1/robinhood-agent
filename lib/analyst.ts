import { SP500_UNIVERSE } from "./strategy";
// Single source of truth for the window. It lives in the LEAF module because the renderer's legend
// promises "in the last 7 days" while this file is what actually enforces it — two independent 7s
// meant changing the cutoff here would silently leave the tag asserting the old window.
import { ANALYST_LOOKBACK_DAYS } from "./analyst-tag";

const FIRM_ABBR: Record<string, string> = {
  "Goldman Sachs": "GS",
  "JPMorgan": "JPM",
  "JP Morgan": "JPM",
  "Morgan Stanley": "MS",
  "Bank of America": "BofA",
  "Citigroup": "Citi",
  "Wells Fargo": "WF",
  "Barclays": "Barc",
  "Deutsche Bank": "DB",
  "UBS": "UBS",
  "Credit Suisse": "CS",
  "Jefferies": "Jeff",
  "Raymond James": "RJ",
  "KeyBanc": "Key",
  "Piper Sandler": "PS",
  "Wolfe Research": "Wolf",
  "Bernstein": "Bern",
  "Evercore": "Evrc",
  "RBC Capital": "RBC",
  "Mizuho": "Mizu",
  "Oppenheimer": "Opp",
  "Stifel": "Stif",
  "Truist": "Trst",
  "TD Cowen": "TDC",
  "Cowen": "Cown",
  "BTIG": "BTIG",
  "BMO Capital": "BMO",
};

function firmShort(name: string): string {
  for (const [key, abbr] of Object.entries(FIRM_ABBR)) {
    if (name.includes(key)) return abbr;
  }
  return name.split(" ")[0].slice(0, 4);
}

// Parses action from news title text since the structured field isn't always populated.
// Returns "upgrade", "downgrade", "initiate", "raise_pt", "lower_pt", or null (reiterate/maintain).
//
// INITIATIONS ARE NOT UPGRADES, and conflating them was a real hazard once the analyst tag reached
// HELD-position lines (2026-09-30). A firm can initiate coverage at ANY rating — including Neutral,
// Peer Perform or Underweight — so an initiation carries no directional view at all. While it
// mapped to "upgrade" it could render as ⚡↑ whenever the initiating price target happened to sit
// ≥15% above the quote, which is MOST LIKELY on a name that has already fallen hard. That is
// precisely the population the loss-discipline and time-stop rules target, and ⚡↑ is their
// documented escape hatch — so a new-coverage note at a neutral rating could excuse keeping a name
// the rules would otherwise force out.
export function parseAction(title: string): "upgrade" | "downgrade" | "initiate" | "raise_pt" | "lower_pt" | null {
  const t = title.toLowerCase();
  if (t.includes("initiates") || t.includes("initiated")) return "initiate";
  if (t.includes("upgrade")) return "upgrade";
  if (t.includes("downgrade")) return "downgrade";
  if (t.includes("raises") || t.includes("raised") || t.includes("increases") || t.includes("boosted")) return "raise_pt";
  if (t.includes("lowers") || t.includes("lowered") || t.includes("cuts") || t.includes("cut") || t.includes("reduces")) return "lower_pt";
  return null; // maintain / reiterate → not signal-worthy
}

export interface AnalystRating {
  symbol: string;
  action: "upgrade" | "downgrade" | "initiate" | "raise_pt" | "lower_pt";
  firm: string;
  firmShort: string;
  priceTarget?: number;       // new PT
  prevPriceTarget?: number;   // old PT (parsed from title when available)
  priceWhenPosted?: number;   // stock price at time of rating
  pctUpside?: number;         // (priceTarget - priceWhenPosted) / priceWhenPosted * 100
  date: string;               // YYYY-MM-DD
}

interface FMPPriceTargetItem {
  symbol?: string;
  publishedDate?: string;
  newsTitle?: string;
  analystCompany?: string;
  priceTarget?: number;
  adjPriceTarget?: number;
  priceWhenPosted?: number;
}

// Parses "raised to $105 from $90" → prevPriceTarget = 90
function parsePrevPT(title: string): number | undefined {
  const m = title.match(/from\s+\$(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : undefined;
}

export async function getAnalystRatings(): Promise<Record<string, AnalystRating[]>> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return {};

  try {
    const res = await fetch(
      `https://financialmodelingprep.com/stable/price-target-latest-news?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return {};

    const data = await res.json() as FMPPriceTargetItem[];
    if (!Array.isArray(data)) return {};

    const symbolSet = new Set(SP500_UNIVERSE);
    const cutoff = new Date(Date.now() - ANALYST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const result: Record<string, AnalystRating[]> = {};

    for (const item of data) {
      if (!item.symbol || !symbolSet.has(item.symbol)) continue;

      const date = item.publishedDate?.slice(0, 10);
      if (!date || new Date(date) < cutoff) continue;

      const title = item.newsTitle ?? "";
      const action = parseAction(title);
      if (!action) continue; // skip reiterations

      const pt = item.adjPriceTarget ?? item.priceTarget;
      const pctUpside = pt && item.priceWhenPosted && item.priceWhenPosted > 0
        ? ((pt - item.priceWhenPosted) / item.priceWhenPosted) * 100
        : undefined;

      const rating: AnalystRating = {
        symbol: item.symbol,
        action,
        firm: item.analystCompany ?? "",
        firmShort: firmShort(item.analystCompany ?? ""),
        priceTarget: pt,
        prevPriceTarget: parsePrevPT(title),
        priceWhenPosted: item.priceWhenPosted,
        pctUpside,
        date,
      };

      (result[item.symbol] ??= []).push(rating);
    }

    return result;
  } catch {
    return {};
  }
}
