import { SP500_UNIVERSE } from "./strategy";
import { getInsiderBuys, type InsiderBuy } from "./insider";
import { getAnalystRatings, type AnalystRating } from "./analyst";
import { fetchUpcomingEarnings } from "./earnings";

export type { InsiderBuy, AnalystRating };

export const SECTOR_ETFS: Record<string, string> = {
  XLK:  "Technology",
  XLC:  "Comm Svcs",
  XLF:  "Financials",
  XLV:  "Health Care",
  XLI:  "Industrials",
  XLY:  "Cons Discret",
  XLP:  "Cons Staples",
  XLE:  "Energy",
  XLB:  "Materials",
  XLRE: "Real Estate",
  XLU:  "Utilities",
};

export const STOCK_SECTOR: Record<string, string> = {
  // Technology (XLK)
  A:"XLK", AAPL:"XLK", ACN:"XLK", ADBE:"XLK", ADI:"XLK", AMAT:"XLK", AMD:"XLK",
  ANSS:"XLK", APH:"XLK", BRKR:"XLK", CDNS:"XLK", CDAY:"XLK", CDW:"XLK", CRM:"XLK",
  CSCO:"XLK", CTSH:"XLK", DXC:"XLK", ENPH:"XLK", EPAM:"XLK", FFIV:"XLK", FICO:"XLK",
  FTNT:"XLK", GEN:"XLK", GDDY:"XLK", GLW:"XLK", HPE:"XLK", HPQ:"XLK", IBM:"XLK",
  INTC:"XLK", INTU:"XLK", IT:"XLK", JKHY:"XLK", JNPR:"XLK", KEYS:"XLK", KLAC:"XLK",
  LDOS:"XLK", LRCX:"XLK", MCHP:"XLK", MPWR:"XLK", MRVL:"XLK", MSFT:"XLK", MU:"XLK",
  NOW:"XLK", NTAP:"XLK", NVDA:"XLK", NXPI:"XLK", ON:"XLK", ORCL:"XLK", PANW:"XLK",
  PLTR:"XLK", // held via the influencer sleeve (not in SP500_UNIVERSE) — mapped so the whole-book risk panel classifies it as Technology
  PAYC:"XLK", PAYX:"XLK", PTC:"XLK", QCOM:"XLK", SNPS:"XLK", STX:"XLK", SWKS:"XLK",
  TDY:"XLK", TEL:"XLK", TER:"XLK", TRMB:"XLK", TXN:"XLK", TYL:"XLK", VRSN:"XLK",
  WDC:"XLK", ZBRA:"XLK", ADSK:"XLK",
  // Communication Services (XLC)
  CHTR:"XLC", CMCSA:"XLC", DIS:"XLC", EA:"XLC", FOXA:"XLC", GOOGL:"XLC", IPG:"XLC",
  LYV:"XLC", META:"XLC", MTCH:"XLC", NFLX:"XLC", NWS:"XLC", NWSA:"XLC", OMC:"XLC",
  PARA:"XLC", T:"XLC", TMUS:"XLC", TTWO:"XLC", VZ:"XLC", WBD:"XLC",
  // Financials (XLF)
  AFL:"XLF", AIG:"XLF", AJG:"XLF", ALL:"XLF", ALLY:"XLF", AMP:"XLF", AON:"XLF",
  AXP:"XLF", BAC:"XLF", BK:"XLF", BLK:"XLF", BRO:"XLF", C:"XLF", CB:"XLF",
  CFG:"XLF", CINF:"XLF", CMA:"XLF", CME:"XLF", COF:"XLF", DFS:"XLF", FI:"XLF",
  FIS:"XLF", FITB:"XLF", FNF:"XLF", GL:"XLF", GPN:"XLF", GS:"XLF", HBAN:"XLF",
  HIG:"XLF", ICE:"XLF", IVZ:"XLF", JPM:"XLF", KEY:"XLF", LNC:"XLF", MA:"XLF",
  MCO:"XLF", MET:"XLF", MKTX:"XLF", MMC:"XLF", MS:"XLF", MTB:"XLF", NDAQ:"XLF",
  NTRS:"XLF", PGR:"XLF", PRU:"XLF", PYPL:"XLF", RF:"XLF", RJF:"XLF", SCHW:"XLF",
  SPGI:"XLF", STT:"XLF", SYF:"XLF", TROW:"XLF", TRV:"XLF", USB:"XLF", V:"XLF",
  WFC:"XLF", WRB:"XLF", ZION:"XLF",
  // Health Care (XLV)
  ABBV:"XLV", ABC:"XLV", ABT:"XLV", ALGN:"XLV", AMGN:"XLV", BAX:"XLV", BDX:"XLV",
  BIO:"XLV", BIIB:"XLV", BMY:"XLV", CI:"XLV", CNC:"XLV", CVS:"XLV", DGX:"XLV",
  DHR:"XLV", DVA:"XLV", DXCM:"XLV", ELV:"XLV", EW:"XLV", GEHC:"XLV", GILD:"XLV",
  HCA:"XLV", HOLX:"XLV", HSIC:"XLV", HUM:"XLV", IDXX:"XLV", ILMN:"XLV", INCY:"XLV",
  IQV:"XLV", ISRG:"XLV", JNJ:"XLV", LH:"XLV", LLY:"XLV", MCK:"XLV", MDT:"XLV",
  MOH:"XLV", MRNA:"XLV", MRK:"XLV", MTD:"XLV", PFE:"XLV", PODD:"XLV", REGN:"XLV",
  RMD:"XLV", STE:"XLV", SYK:"XLV", TECH:"XLV", TFX:"XLV", TMO:"XLV", UNH:"XLV",
  VRTX:"XLV", WAT:"XLV", WST:"XLV", XRAY:"XLV", ZBH:"XLV", ZTS:"XLV",
  // Industrials (XLI)
  AGCO:"XLI", ALLE:"XLI", AME:"XLI", AOS:"XLI", AXON:"XLI", BA:"XLI", CARR:"XLI",
  CAT:"XLI", CHRW:"XLI", CTAS:"XLI", CSX:"XLI", DAL:"XLI", DE:"XLI", DOV:"XLI",
  EMR:"XLI", ETN:"XLI", EXPD:"XLI", FAST:"XLI", FDX:"XLI", GD:"XLI", GE:"XLI",
  GWW:"XLI", GXO:"XLI", HII:"XLI", HON:"XLI", HUBB:"XLI", HWM:"XLI", IEX:"XLI",
  IR:"XLI", J:"XLI", JBHT:"XLI", KNX:"XLI", LHX:"XLI", LMT:"XLI", LSTR:"XLI",
  LUV:"XLI", MAS:"XLI", MMM:"XLI", NDSN:"XLI", NSC:"XLI", OC:"XLI", OTIS:"XLI",
  PCAR:"XLI", PH:"XLI", PNR:"XLI", PWR:"XLI", ROK:"XLI", RSG:"XLI", RTX:"XLI",
  RRX:"XLI", SAIC:"XLI", SNA:"XLI", SWK:"XLI", TDG:"XLI", TXT:"XLI", UAL:"XLI",
  UNP:"XLI", UPS:"XLI", URI:"XLI", WAB:"XLI", WM:"XLI", XYL:"XLI",
  // Consumer Discretionary (XLY)
  AMZN:"XLY", AN:"XLY", APTV:"XLY", AZO:"XLY", BBWI:"XLY", BBY:"XLY", BKNG:"XLY",
  BURL:"XLY", BWA:"XLY", CCL:"XLY", CMG:"XLY", CZR:"XLY", DHI:"XLY", DG:"XLY",
  DLTR:"XLY", DPZ:"XLY", DRI:"XLY", EBAY:"XLY", EL:"XLY", ETSY:"XLY", EXPE:"XLY",
  F:"XLY", GM:"XLY", GRMN:"XLY", HAS:"XLY", HD:"XLY", HLT:"XLY", KMX:"XLY",
  LEN:"XLY", LKQ:"XLY", LOW:"XLY", LVS:"XLY", MAR:"XLY", MAT:"XLY", MCD:"XLY",
  MGM:"XLY", MHK:"XLY", NCLH:"XLY", NKE:"XLY", NVR:"XLY", ORLY:"XLY", PHM:"XLY",
  PVH:"XLY", RCL:"XLY", RL:"XLY", ROST:"XLY", SBUX:"XLY", TGT:"XLY", TJX:"XLY",
  TPR:"XLY", TSLA:"XLY", VFC:"XLY", WHR:"XLY", WYNN:"XLY", YUM:"XLY",
  // Consumer Staples (XLP)
  ADM:"XLP", CAG:"XLP", CHD:"XLP", CL:"XLP", CLX:"XLP", COST:"XLP", CPB:"XLP",
  GIS:"XLP", HRL:"XLP", HSY:"XLP", K:"XLP", KHC:"XLP", KMB:"XLP", KO:"XLP",
  KR:"XLP", LW:"XLP", MKC:"XLP", MDLZ:"XLP", MO:"XLP", PEP:"XLP", PG:"XLP",
  PM:"XLP", POST:"XLP", SJM:"XLP", STZ:"XLP", SYY:"XLP", TAP:"XLP", TSN:"XLP",
  WBA:"XLP", WMT:"XLP",
  // Energy (XLE)
  APA:"XLE", AR:"XLE", BKR:"XLE", COP:"XLE", CTRA:"XLE", CVX:"XLE", DVN:"XLE",
  EOG:"XLE", EQT:"XLE", FANG:"XLE", HAL:"XLE", HES:"XLE", KMI:"XLE", MPC:"XLE",
  MRO:"XLE", OKE:"XLE", OXY:"XLE", PSX:"XLE", SLB:"XLE", TRGP:"XLE", VLO:"XLE",
  WMB:"XLE", XOM:"XLE",
  // Materials (XLB)
  ALB:"XLB", APD:"XLB", BALL:"XLB", CCK:"XLB", CE:"XLB", CF:"XLB", DD:"XLB",
  DOW:"XLB", ECL:"XLB", EMN:"XLB", FCX:"XLB", FMC:"XLB", IFF:"XLB", IP:"XLB",
  LIN:"XLB", LYB:"XLB", MLM:"XLB", MOS:"XLB", NEM:"XLB", NUE:"XLB", OLN:"XLB",
  PKG:"XLB", PPG:"XLB", RPM:"XLB", SHW:"XLB", STLD:"XLB", VMC:"XLB", WRK:"XLB",
  // Real Estate (XLRE)
  AMT:"XLRE", ARE:"XLRE", AVB:"XLRE", BXP:"XLRE", CBRE:"XLRE", CCI:"XLRE", DLR:"XLRE",
  EQIX:"XLRE", EQR:"XLRE", EXR:"XLRE", FRT:"XLRE", HST:"XLRE", IRM:"XLRE", KIM:"XLRE",
  MAA:"XLRE", NNN:"XLRE", O:"XLRE", PLD:"XLRE", PSA:"XLRE", SBAC:"XLRE", SPG:"XLRE",
  UDR:"XLRE", VICI:"XLRE", VTR:"XLRE", WELL:"XLRE", WY:"XLRE",
  // Utilities (XLU)
  AEP:"XLU", AES:"XLU", ATO:"XLU", AWK:"XLU", CMS:"XLU", CNP:"XLU", D:"XLU",
  DTE:"XLU", DUK:"XLU", ED:"XLU", EIX:"XLU", ES:"XLU", ETR:"XLU", EVRG:"XLU",
  EXC:"XLU", LNT:"XLU", NEE:"XLU", NI:"XLU", PEG:"XLU", PNW:"XLU", PPL:"XLU",
  SO:"XLU", SRE:"XLU", WEC:"XLU", XEL:"XLU",
};

export interface SectorData {
  etf: string;
  name: string;
  change30d: number;
  relStrength30d: number;
  sharpe30d: number;
}

export interface StockData {
  symbol: string;
  price: number;
  change1d: number;        // % 1-day change
  change5d: number;        // % 5-trading-day (~1 week) change
  change14d: number;       // % 14-calendar-day (~10 trading day) change
  change30d: number;       // % 30-day change
  distFrom52wHigh: number; // % below 52-week high
  volatility30d: number;   // annualized vol % (30d window)
  sharpe5d: number;        // momentumScore(change5d, 5, vol) — annualized 5d return ÷ full-window vol; PRIMARY sort signal (labeled "mom5")
  sharpe14d: number;       // momentumScore(change14d, 10, vol) — annualized 14d(≈10td) return ÷ full-window vol; confirmation ("mom14")
  sharpe30d: number;       // momentumScore(change30d, 21, vol) — annualized 30d(≈21td) return ÷ full-window vol
  mom12_1: number | null;  // 12-1 momentum %: return from ~252td ago to ~21td ago (V1 primary signal). null = insufficient history.
  beta: number | null;     // β vs SPY over the ~1mo daily window: cov(stock,spy)/var(spy). >1 swings more than the market, <1 less, negative = inverse. null = insufficient/untrustworthy data.
  earningsDate: string | null;
  relStrength1d: number;   // change1d minus SPY's change1d
  relStrength5d: number;   // change5d minus SPY's change5d (near-term alpha)
  relStrength14d: number;  // change14d minus SPY's change14d
  relStrength30d: number;  // change30d minus SPY's change30d (alpha vs market)
}

export interface MarketData {
  stocks: StockData[];
  sectors: SectorData[];
  headlines: string[];
  fetchedAt: string;
  insiderBuys: Record<string, InsiderBuy[]>;
  analystRatings: Record<string, AnalystRating[]>;
  spyContext: { change1d: number; change30d: number } | null;
}

export async function getMarketData(): Promise<MarketData> {
  const [priceResult, headlines, insiderBuys, analystRatings, upcomingEarnings] = await Promise.all([
    getPriceData(),
    getNewsHeadlines(),
    getInsiderBuys(),
    getAnalystRatings(),
    fetchUpcomingEarnings(30),
  ]);
  // Backstop earningsDate from FMP. Yahoo's chart API no longer returns
  // meta.earningsTimestamp (verified absent 2026-07-23), which had left the daily
  // analysis blind to earnings (the ⚠EARN / ⚠⚠ IMMINENT flags never fired). This
  // restores that awareness. Union: keep the earliest upcoming date of the two sources.
  for (const s of priceResult.stocks) {
    const fmp = upcomingEarnings.get(s.symbol);
    if (fmp && (!s.earningsDate || fmp < s.earningsDate)) s.earningsDate = fmp;
  }
  return {
    stocks: priceResult.stocks,
    sectors: priceResult.sectors,
    headlines,
    fetchedAt: new Date().toISOString(),
    insiderBuys,
    analystRatings,
    spyContext: priceResult.spyContext,
  };
}

function annualizedVol(closes: number[]): number {
  if (closes.length < 3) return 0;
  const returns = dailyReturns(closes);
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

// Simple daily returns from a close series (r_t = close_t / close_{t-1} − 1).
function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

// β vs SPY = cov(stock, spy) / var(spy) over daily returns aligned by trading day.
// Returns null when β can't be trusted — too little history, SPY has no variance, OR
// the two return series differ in length (a dropped/halted bar in one but not the other
// would make positional pairing mix non-contemporaneous days and corrupt the covariance).
// null means "unknown", distinct from a real reading of 0 or a negative (inverse) β, both
// of which are legitimate and must flow through to the caller.
export function computeStockBeta(stockCloses: number[], spyCloses: number[]): number | null {
  const s = dailyReturns(stockCloses);
  const m = dailyReturns(spyCloses);
  if (s.length !== m.length || s.length < 5) return null;
  const n = s.length;
  const meanS = s.reduce((a, b) => a + b, 0) / n;
  const meanM = m.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varM = 0;
  for (let i = 0; i < n; i++) {
    cov += (s[i] - meanS) * (m[i] - meanM);
    varM += (m[i] - meanM) ** 2;
  }
  if (varM === 0) return null;
  return cov / varM;
}

// Risk-adjusted momentum score: annualized N-day return ÷ volatility^VOL_PENALTY_EXP.
// Annualizing the return (× 252/tradingDays) puts the 5d/14d/30d scores on the SAME
// scale, so the blended rank (0.6×mom5 + 0.4×mom14) weights them as intended — previously
// the un-annualized 14-day return was ~2–3× larger and silently dominated the "primary"
// 5-day signal. Using one stable full-window vol as the denominator (not a noisy ~5-point
// estimate) keeps the risk adjustment meaningful on short windows. Shared with the eval
// fixtures so tests track production.
//
// VOL_PENALTY_EXP controls how hard volatility is penalized in the rank:
//   1.0 = full Sharpe-like adjustment (favors steady low-vol/low-beta names — the book
//         ran beta<1 and went flat on the market's up days)
//   0.5 = HALF penalty (current) — a deliberate tilt toward higher-beta names so the book
//         captures more of the market's green days, while keeping some risk adjustment
//   0.0 = pure raw-momentum (chases the biggest movers; highest beta, riskiest)
// Tune toward 1.0 to calm it down, toward 0.0 to get more aggressive. Watch the dashboard
// beta tile — aim for ~0.9–1.0, not >1.2. (2026-06-30: lowered 1.0→0.5 per owner.)
export const VOL_PENALTY_EXP = 0.5;

export function momentumScore(changePct: number, tradingDays: number, annualizedVolPct: number): number {
  if (annualizedVolPct <= 0 || tradingDays <= 0) return 0;
  return (changePct * (252 / tradingDays)) / Math.pow(annualizedVolPct, VOL_PENALTY_EXP);
}

// ── V1 Quality-Momentum shortlist (the deterministic "rails") ────────────────────────────────────────
// Given the universe + the quality-eligible set, returns the main-book candidate shortlist the LLM may
// pick from: quality-eligible names with POSITIVE 12-1 momentum, ranked by that momentum, capped so no
// sector exceeds the 40% cap of an N-name book. Because the shortlist itself is sector-capped, ANY N the
// LLM picks from it respects the 40% cap by construction. See docs/strategy-quality-momentum.md.
export function buildV1Shortlist(
  stocks: StockData[],
  eligible: Set<string>,
  opts: { N?: number; shortlistSize?: number } = {},
): StockData[] {
  const N = opts.N ?? 6;
  const maxPerSector = Math.max(1, Math.floor(0.4 * N)); // N=6 → 2/sector
  const size = opts.shortlistSize ?? 12;
  const ranked = stocks
    .filter((s) => typeof s.mom12_1 === "number" && (s.mom12_1 as number) > 0 && eligible.has(s.symbol))
    .sort((a, b) => (b.mom12_1 as number) - (a.mom12_1 as number));
  const picked: StockData[] = [];
  const perSector: Record<string, number> = {};
  for (const s of ranked) {
    if (picked.length >= size) break;
    const sec = STOCK_SECTOR[s.symbol] ?? "?";
    if ((perSector[sec] ?? 0) >= maxPerSector) continue;
    picked.push(s);
    perSector[sec] = (perSector[sec] ?? 0) + 1;
  }
  return picked;
}

// Renders the V1 shortlist as a compact table for the analysis prompt. quality is the SEC-derived
// per-symbol quality percentile (0–1). Flags earnings within 30d so the model can avoid imminent ones.
export function formatV1Shortlist(
  shortlist: StockData[],
  quality: Record<string, { quality: number }>,
  insiderBuys: Record<string, InsiderBuy[]> = {},
  analystRatings: Record<string, AnalystRating[]> = {},
): string {
  // Re-surface the insider + analyst signals we fetch every run but V1 had dropped
  // from this table. Context flags — the model weighs them among the shortlist (a
  // ↓FIRM is a risk headwind, a ★INS/⚡↑ raises conviction); they do NOT override the
  // rails (still only shortlist names, within the caps). Same intent as ⚠EARN.
  const insFlag = (sym: string) => (insiderBuys[sym]?.length ? " ★INS" : "");
  const analystFlag = (sym: string): string => {
    const ratings = analystRatings[sym];
    if (!ratings?.length) return "";
    return [...ratings]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 2)
      .map((r) => {
        const arrow = r.action === "upgrade" || r.action === "raise_pt" ? "↑" : "↓";
        const pt = r.priceTarget ? `$${r.priceTarget.toFixed(0)}` : "";
        const upside = r.pctUpside != null ? `(${r.pctUpside >= 0 ? "+" : ""}${r.pctUpside.toFixed(0)}%)` : "";
        const impact = r.action === "upgrade" && (r.pctUpside ?? 0) >= 15 ? "⚡" : "";
        return ` ${impact}${arrow}${r.firmShort}${pt}${upside}`;
      })
      .join("");
  };
  const rows = shortlist.map((s) => {
    const q = quality[s.symbol]?.quality;
    const earn = s.earningsDate ? `  ⚠EARN ${s.earningsDate}` : "";
    return `${s.symbol.padEnd(6)} $${s.price.toFixed(0).padStart(5)} | 12-1mom: ${(s.mom12_1 ?? 0).toFixed(0).padStart(5)}% | quality: ${q != null ? q.toFixed(2) : "—"} | β${(s.beta != null ? s.beta.toFixed(2) : "—").padStart(5)} | ${SECTOR_ETFS[STOCK_SECTOR[s.symbol]] ?? STOCK_SECTOR[s.symbol] ?? "?"}${earn}${insFlag(s.symbol)}${analystFlag(s.symbol)}`;
  });
  return `sym     price  | 12-mo momentum | quality(0-1) |  β   | sector   [context flags — weigh among the list, they do NOT override the shortlist/caps: ★INS = recent insider buying (conviction) · ⚡↑/↑FIRM = analyst upgrade/PT-raise, ⚡ = impactful catalyst (≥15% upside) · ↓FIRM = downgrade/PT-cut (a risk headwind even on strong momentum — prefer another name or trim) · ⚠EARN = earnings ≤30d]\n${rows.join("\n")}`;
}

async function fetchQuote(symbol: string): Promise<(StockData & { _closes: number[] }) | null> {
  try {
    // 2y so we have ≥253 trading days for 12-1 momentum (needs the close ~252td before the ~21td-ago
    // anchor). 30d/vol/beta below anchor off the tail, so the wider window doesn't distort them.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data = await res.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            regularMarketPreviousClose?: number;
            chartPreviousClose?: number;
            fiftyTwoWeekHigh?: number;
            earningsTimestamp?: number;
          };
          indicators?: { quote?: Array<{ close?: number[] }> };
        }>;
      };
    };

    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta ?? {};
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter((c): c is number => c != null);

    const price = meta.regularMarketPrice ?? 0;
    // regularMarketPreviousClose = actual previous session close; chartPreviousClose = close before range start (~1mo ago)
    const prevClose = meta.regularMarketPreviousClose ?? meta.chartPreviousClose ?? price;
    // Anchor 30d off ~21 trading days back (NOT validCloses[0], which is now ~1yr ago after widening
    // the fetch to 1y for the 12-1 momentum signal).
    const monthAgoClose = validCloses[Math.max(0, validCloses.length - 22)] ?? price;
    const high52w = meta.fiftyTwoWeekHigh ?? price;
    const change30d = monthAgoClose ? ((price - monthAgoClose) / monthAgoClose) * 100 : 0;
    const vol = annualizedVol(validCloses.slice(-22)); // keep vol on the ~1mo window (full 1y would differ)

    // 12-1 momentum (V1 primary signal): return from ~252 trading days ago to ~21 trading days ago
    // (12-month formation, skipping the most recent month per the momentum convention). % ; null if short.
    const n = validCloses.length;
    const mom12_1 = n >= 253 ? (validCloses[n - 22] / validCloses[n - 253] - 1) * 100 : null;

    // 5-trading-day signal (~1 week)
    const closes5d = validCloses.slice(-6); // 5 trading days + anchor
    const fiveDayAgoClose = closes5d[0] ?? monthAgoClose;
    const change5d = fiveDayAgoClose ? ((price - fiveDayAgoClose) / fiveDayAgoClose) * 100 : 0;
    const sharpe5d = momentumScore(change5d, 5, vol);

    // 14-calendar-day signal (~10 trading days back in the closes array)
    const closes14d = validCloses.slice(-11); // last 10 trading days + anchor
    const twoWeekAgoClose = closes14d[0] ?? monthAgoClose;
    const change14d = twoWeekAgoClose ? ((price - twoWeekAgoClose) / twoWeekAgoClose) * 100 : 0;
    const sharpe14d = momentumScore(change14d, 10, vol);

    const nowMs = Date.now();
    const earningsTs = meta.earningsTimestamp;
    const earningsMs = earningsTs ? earningsTs * 1000 : null;
    const daysOut = earningsMs ? (earningsMs - nowMs) / 86_400_000 : null;
    const earningsDate =
      daysOut != null && daysOut >= 0 && daysOut <= 30
        ? new Date(earningsMs!).toISOString().split("T")[0]
        : null;

    return {
      symbol,
      price,
      change1d: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
      change5d,
      change14d,
      change30d,
      distFrom52wHigh: high52w ? ((price - high52w) / high52w) * 100 : 0,
      volatility30d: vol,
      sharpe5d,
      sharpe14d,
      sharpe30d: momentumScore(change30d, 21, vol),
      mom12_1,
      beta: null,         // set below in getPriceData once SPY closes are known
      _closes: validCloses, // retained only to compute beta vs SPY; stripped before return
      earningsDate,
      relStrength1d: 0,   // set below after SPY fetch
      relStrength5d: 0,   // set below after SPY fetch
      relStrength14d: 0,  // set below after SPY fetch
      relStrength30d: 0,  // set below after SPY fetch
    };
  } catch {
    return null;
  }
}

async function getPriceData(): Promise<{
  stocks: StockData[];
  sectors: SectorData[];
  spyContext: { change1d: number; change30d: number } | null;
}> {
  const sectorTickers = Object.keys(SECTOR_ETFS);

  const [spyResult, ...rest] = await Promise.allSettled([
    fetchQuote("SPY"),
    ...SP500_UNIVERSE.map(fetchQuote),
    ...sectorTickers.map(fetchQuote),
  ]);

  const stockResults = rest.slice(0, SP500_UNIVERSE.length);
  const sectorResults = rest.slice(SP500_UNIVERSE.length);

  const spy = spyResult.status === "fulfilled" ? spyResult.value : null;
  const spyChange1d = spy?.change1d ?? 0;
  const spyChange5d = spy?.change5d ?? 0;
  const spyChange14d = spy?.change14d ?? 0;
  const spyChange30d = spy?.change30d ?? 0;
  const spyCloses = spy?._closes ?? [];

  const stocks = stockResults
    .filter((r): r is PromiseFulfilledResult<StockData & { _closes: number[] }> => r.status === "fulfilled" && r.value !== null)
    .map((r) => {
      const { _closes, ...s } = r.value!;
      return {
        ...s,
        beta: computeStockBeta(_closes.slice(-22), spyCloses.slice(-22)), // ~1mo window (fetch is now 1y)
        relStrength1d: s.change1d - spyChange1d,
        relStrength5d: s.change5d - spyChange5d,
        relStrength14d: s.change14d - spyChange14d,
        relStrength30d: s.change30d - spyChange30d,
      };
    })
    // Primary sort: composite of 5d (near-term) + 14d (confirmation)
    .sort((a, b) => (b.sharpe5d * 0.6 + b.sharpe14d * 0.4) - (a.sharpe5d * 0.6 + a.sharpe14d * 0.4));

  const sectors: SectorData[] = sectorResults
    .map((r, i) => {
      if (r.status !== "fulfilled" || !r.value) return null;
      const s = r.value;
      return {
        etf: sectorTickers[i],
        name: SECTOR_ETFS[sectorTickers[i]],
        change30d: s.change30d,
        relStrength30d: s.change30d - spyChange30d,
        sharpe30d: s.sharpe30d,
      };
    })
    .filter((s): s is SectorData => s !== null)
    .sort((a, b) => b.relStrength30d - a.relStrength30d);

  return {
    stocks,
    sectors,
    spyContext: spy ? { change1d: spyChange1d, change30d: spyChange30d } : null,
  };
}

async function getNewsHeadlines(): Promise<string[]> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=20&apiKey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as {
      articles?: { source?: { name?: string }; title?: string }[];
    };
    return (data.articles ?? [])
      .filter((a) => a.title && !a.title.includes("[Removed]"))
      .map((a) => `[${a.source?.name ?? "News"}] ${a.title}`);
  } catch {
    return [];
  }
}

export async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

// Ensure `priceMap` holds a real, positive MARKET price for every symbol in `symbols`,
// fetching a live quote for any that's missing. Used when snapshotting held positions so a
// position's recorded `price` is never silently its avgCost. priceMap is built only from the
// S&P universe (+ top influencer momentum), so a held influencer name (e.g. PLTR outside the
// top-12) or any symbol whose Yahoo fetch failed that run is absent — and the old
// `priceMap.get(sym) ?? avgCost` fallback then stored price == avgCost. That placeholder
// injects a phantom day-over-day move into the sleeve-return series (PLTR 2026-07-08 stored
// its $116.26 cost as "price" while it traded ~$132, so the next day read a bogus +8%).
// Mutates priceMap in place; returns the symbols that STILL couldn't be priced (live fetch
// failed) so the caller can log the last-resort fallback instead of it being silent.
export async function enrichPriceMap(
  symbols: string[],
  priceMap: Map<string, number>,
): Promise<string[]> {
  const missing = [...new Set(symbols)].filter((s) => s.length > 0 && !((priceMap.get(s) ?? 0) > 0));
  if (missing.length === 0) return [];
  const results = await Promise.allSettled(missing.map((s) => fetchCurrentPrice(s).then((p) => ({ s, p }))));
  const unresolved: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.p != null && r.value.p > 0) {
      priceMap.set(r.value.s, r.value.p);
    } else if (r.status === "fulfilled") {
      unresolved.push(r.value.s);
    }
  }
  return unresolved;
}

// Lightweight single-symbol quote (price + 1-day % change). Lets the stop-check
// detect drops from just the held positions instead of fetching the full universe,
// so it can run frequently (hourly) without hammering Yahoo.
export async function fetchQuoteLite(symbol: string): Promise<{ price: number; change1d: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketPreviousClose?: number; chartPreviousClose?: number } }> };
    };
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const prevClose = meta.regularMarketPreviousClose ?? meta.chartPreviousClose ?? price;
    const change1d = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return { price, change1d };
  } catch {
    return null;
  }
}

// Price + downtrend signals for any single ticker. Used to screen influencer picks
// for falling knives before buying (so the agent doesn't buy a crashing stock on hype,
// the way it bought SPCX mid-decline). Returns BOTH 5-day net change and distance from
// the recent 10-day high — the latter catches pump-and-dump names (e.g. a fresh IPO
// that spiked then fell) where the 5-day net is misleadingly mild.
export async function fetchMomentum(symbol: string): Promise<{ price: number; change5d: number; distFromHigh: number; aboveShortMA: boolean } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number }; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
    };
    const r = data?.chart?.result?.[0];
    const price = r?.meta?.regularMarketPrice;
    if (!price) return null;
    const closes = (r?.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => c != null);
    const fiveAgo = closes.length >= 6 ? closes[closes.length - 6] : closes[0];
    const change5d = fiveAgo ? ((price - fiveAgo) / fiveAgo) * 100 : 0;
    const recentHigh = Math.max(price, ...closes.slice(-10));
    const distFromHigh = recentHigh > 0 ? ((price - recentHigh) / recentHigh) * 100 : 0;
    // Confirmed-recovery signal: price above its 5-day moving average = the short-term
    // trend has turned up (a single bounce day off a low is still below the 5d average).
    const last5 = closes.slice(-5);
    const fiveDayAvg = last5.length ? last5.reduce((s, c) => s + c, 0) / last5.length : price;
    const aboveShortMA = price > fiveDayAvg;
    return { price, change5d, distFromHigh, aboveShortMA };
  } catch {
    return null;
  }
}

export function formatMarketDataForPrompt(data: MarketData): string {
  const isImpactfulUpgrade = (ratings: import("./analyst").AnalystRating[]) =>
    ratings.some((r) => r.action === "upgrade" && (r.pctUpside ?? 0) >= 15);

  // Sort by composite 5d+14d score + boost for impactful analyst upgrades
  const effectiveScore = (s: StockData) => {
    const ratings = data.analystRatings[s.symbol] ?? [];
    return (s.sharpe5d * 0.6 + s.sharpe14d * 0.4) + (isImpactfulUpgrade(ratings) ? 0.3 : 0);
  };

  const bySharpe = [...data.stocks].sort((a, b) => effectiveScore(b) - effectiveScore(a));
  const top10 = bySharpe.slice(0, 10);
  const bottom10 = bySharpe.slice(-10);

  const spyLine = data.spyContext
    ? `SPY (market baseline): 1d ${data.spyContext.change1d >= 0 ? "+" : ""}${data.spyContext.change1d.toFixed(1)}% | 30d ${data.spyContext.change30d >= 0 ? "+" : ""}${data.spyContext.change30d.toFixed(1)}%`
    : "SPY: unavailable";

  const hasInsider = (s: StockData) => (data.insiderBuys[s.symbol]?.length ?? 0) > 0;

  const analystFlag = (s: StockData): string => {
    const ratings = data.analystRatings[s.symbol];
    if (!ratings?.length) return "";
    return [...ratings]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 2)
      .map((r) => {
        const isPositive = r.action === "upgrade" || r.action === "raise_pt";
        const arrow = isPositive ? "↑" : "↓";
        const pt = r.priceTarget ? `$${r.priceTarget.toFixed(0)}` : "";
        const upside = r.pctUpside != null ? `(${r.pctUpside >= 0 ? "+" : ""}${r.pctUpside.toFixed(0)}%)` : "";
        const impact = r.action === "upgrade" && (r.pctUpside ?? 0) >= 15 ? "⚡" : "";
        return ` ${impact}${arrow}${r.firmShort}${pt}${upside}`;
      })
      .join("");
  };

  // Show top 40 by sharpe + any stock outside the top 40 that has a signal (insider/analyst).
  const TOP_TABLE = 40;
  const signalSet = new Set(
    bySharpe
      .slice(TOP_TABLE)
      .filter(s => hasInsider(s) || (data.analystRatings[s.symbol]?.length ?? 0) > 0)
      .map(s => s.symbol)
  );
  const tableStocks = bySharpe.filter((s, i) => i < TOP_TABLE || signalSet.has(s.symbol));

  const momentumTable = tableStocks
    .map((s) => {
      const d1 = (s.change1d >= 0 ? "+" : "") + s.change1d.toFixed(1) + "%";
      const d5 = (s.change5d >= 0 ? "+" : "") + s.change5d.toFixed(1) + "%";
      const alpha5 = (s.relStrength5d >= 0 ? "+" : "") + s.relStrength5d.toFixed(1) + "%";
      const sharpe5 = s.sharpe5d.toFixed(2);
      const d14 = (s.change14d >= 0 ? "+" : "") + s.change14d.toFixed(1) + "%";
      const alpha14 = (s.relStrength14d >= 0 ? "+" : "") + s.relStrength14d.toFixed(1) + "%";
      const d30 = (s.change30d >= 0 ? "+" : "") + s.change30d.toFixed(1) + "%";
      const fromHigh = s.distFrom52wHigh.toFixed(1) + "%";
      const beta = s.beta != null ? s.beta.toFixed(2) : "  —"; // — = unknown; a real 0/negative β still renders (it's a diversifier signal)
      const earnFlag = s.earningsDate ? ` ⚠EARN ${s.earningsDate.slice(5)}` : "";
      const insFlag = hasInsider(s) ? " ★INS" : "";
      const sect = STOCK_SECTOR[s.symbol] ?? "?";
      return `${s.symbol.padEnd(6)} $${s.price.toFixed(0).padStart(5)} | 1d: ${d1.padStart(7)} | 5d: ${d5.padStart(7)} | α5d: ${alpha5.padStart(7)} | mom5: ${sharpe5.padStart(5)} | 14d:${d14.padStart(8)} | α14d: ${alpha14.padStart(7)} | 30d: ${d30.padStart(8)} | vs52wHigh: ${fromHigh} | β${beta.padStart(5)} | ${sect}${earnFlag}${insFlag}${analystFlag(s)}`;
    })
    .join("\n");

  // Earnings warnings section
  const earningsWarnings = data.stocks
    .filter((s) => s.earningsDate != null)
    .sort((a, b) => a.earningsDate!.localeCompare(b.earningsDate!));

  const earningsSection = earningsWarnings.length > 0
    ? `\nUPCOMING EARNINGS (next 30 days):\n` +
      earningsWarnings.map((s) => {
        const daysOut = Math.round((new Date(s.earningsDate!).getTime() - Date.now()) / 86_400_000);
        const urgency = daysOut <= 3 ? "⚠⚠ IMMINENT" : daysOut <= 7 ? "⚠ THIS WEEK" : "  upcoming";
        return `  ${urgency} ${s.symbol} ${s.earningsDate} (${daysOut}d)`;
      }).join("\n")
    : "";

  // Insider buying section
  const insiderEntries = Object.entries(data.insiderBuys).filter(([, buys]) => buys.length > 0);
  const insiderSection = insiderEntries.length > 0
    ? `\nRECENT INSIDER BUYING (last 30 days — open market purchases by officers/directors):\n` +
      insiderEntries
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([symbol, buys]) =>
          buys.map((b) => {
            const total = b.totalValue >= 1_000_000
              ? `$${(b.totalValue / 1_000_000).toFixed(1)}M`
              : `$${Math.round(b.totalValue / 1000)}k`;
            return `  ★ ${symbol}: ${b.ownerName} (${b.ownerTitle}) bought ${b.shares.toLocaleString()} shares @ $${b.pricePerShare.toFixed(2)} (${total}) on ${b.filingDate}`;
          })
        )
        .join("\n")
    : "\nRECENT INSIDER BUYING: None detected in last 30 days.";

  // Analyst ratings section
  const analystEntries = Object.entries(data.analystRatings).filter(([, ratings]) => ratings.length > 0);
  const analystSection = analystEntries.length > 0
    ? `\nANALYST ACTIONS (last 7 days — upgrades ↑, downgrades ↓, PT changes with upside/downside vs price at time of rating):\n` +
      analystEntries
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([symbol, ratings]) =>
          [...ratings]
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((r) => {
              const isPositive = r.action === "upgrade" || r.action === "raise_pt";
              const arrow = isPositive ? "↑" : "↓";
              const actionLabel = r.action === "upgrade" ? "upgraded" : r.action === "downgrade" ? "downgraded" : r.action === "raise_pt" ? "raised PT" : "lowered PT";
              const ptPart = r.priceTarget
                ? `, PT $${r.priceTarget.toFixed(0)}${r.prevPriceTarget ? ` (from $${r.prevPriceTarget.toFixed(0)})` : ""}${r.pctUpside != null ? ` — ${r.pctUpside >= 0 ? "+" : ""}${r.pctUpside.toFixed(0)}% upside vs price at rating` : ""}`
                : "";
              return `  ${arrow} ${symbol}: ${r.firm} ${actionLabel}${ptPart} on ${r.date}`;
            })
        )
        .join("\n")
    : "\nANALYST ACTIONS: No upgrades, downgrades, or PT changes in last 7 days.";

  const headlines = data.headlines.length > 0
    ? data.headlines.map((h) => `- ${h}`).join("\n")
    : "- No headlines available";

  const sectorTable = data.sectors.length > 0
    ? data.sectors.map((s, i) => {
        const d30 = (s.change30d >= 0 ? "+" : "") + s.change30d.toFixed(1) + "%";
        const alpha = (s.relStrength30d >= 0 ? "+" : "") + s.relStrength30d.toFixed(1) + "%";
        const sharpe = s.sharpe30d.toFixed(2);
        const tag = i === 0 ? " 🔥 HOT" : i >= data.sectors.length - 2 ? " ❄ COLD" : "";
        return `  ${s.etf.padEnd(5)} ${s.name.padEnd(13)} 30d: ${d30.padStart(7)} | α30d: ${alpha.padStart(7)} | mom: ${sharpe.padStart(5)}${tag}`;
      }).join("\n")
    : "  (unavailable)";

  return `
--- REAL-TIME MARKET DATA (fetched ${data.fetchedAt}) ---

${spyLine}

SECTOR ROTATION (sorted by α30d vs SPY — use this to identify macro tailwinds/headwinds):
${sectorTable}

TOP 10 NEAR-TERM MOMENTUM (mom5 = risk-adjusted momentum: annualized 5d return ÷ volatility, higher = stronger & steadier | α5d = alpha vs SPY over 5d):
${top10.map((s) => `${s.symbol} mom5=${s.sharpe5d.toFixed(2)} α5d=${s.relStrength5d >= 0 ? "+" : ""}${s.relStrength5d.toFixed(1)}% mom14=${s.sharpe14d.toFixed(2)}${hasInsider(s) ? " ★INS" : ""}${analystFlag(s)}`).join(", ")}

BOTTOM 10 (weakest near-term risk-adjusted momentum):
${bottom10.map((s) => `${s.symbol} mom5=${s.sharpe5d.toFixed(2)} α5d=${s.relStrength5d >= 0 ? "+" : ""}${s.relStrength5d.toFixed(1)}%`).join(", ")}

FULL TABLE (sorted by 60%×mom5 + 40%×mom14 | 5d = PRIMARY signal | 14d = confirmation | 30d = trend context | α5d/α14d = vs SPY | sect = sector ETF | ★INS = insider bought | ↑/↓FIRM = analyst upgrade/downgrade | ⚠EARN = earnings within 30d):
Symbol Price  | 1d      | 5d      | α5d     | mom5     | 14d      | α14d    | 30d      | vs52wHigh | sect
${momentumTable}
${earningsSection}
${insiderSection}
${analystSection}

RECENT BUSINESS HEADLINES:
${headlines}

--- END MARKET DATA ---
`;
}
