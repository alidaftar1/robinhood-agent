import { SP500_UNIVERSE } from "./strategy";
import { getInsiderBuys, type InsiderBuy } from "./insider";
import { getAnalystRatings, type AnalystRating } from "./analyst";

export type { InsiderBuy, AnalystRating };

const SECTOR_ETFS: Record<string, string> = {
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

const STOCK_SECTOR: Record<string, string> = {
  // Technology (XLK)
  A:"XLK", AAPL:"XLK", ACN:"XLK", ADBE:"XLK", ADI:"XLK", AMAT:"XLK", AMD:"XLK",
  ANSS:"XLK", APH:"XLK", BRKR:"XLK", CDNS:"XLK", CDAY:"XLK", CDW:"XLK", CRM:"XLK",
  CSCO:"XLK", CTSH:"XLK", DXC:"XLK", ENPH:"XLK", EPAM:"XLK", FFIV:"XLK", FICO:"XLK",
  FTNT:"XLK", GEN:"XLK", GDDY:"XLK", GLW:"XLK", HPE:"XLK", HPQ:"XLK", IBM:"XLK",
  INTC:"XLK", INTU:"XLK", IT:"XLK", JKHY:"XLK", JNPR:"XLK", KEYS:"XLK", KLAC:"XLK",
  LDOS:"XLK", LRCX:"XLK", MCHP:"XLK", MPWR:"XLK", MRVL:"XLK", MSFT:"XLK", MU:"XLK",
  NOW:"XLK", NTAP:"XLK", NVDA:"XLK", NXPI:"XLK", ON:"XLK", ORCL:"XLK", PANW:"XLK",
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
  sharpe5d: number;        // change5d / annualized vol (5d window) — primary sort signal
  sharpe14d: number;       // change14d / annualized vol (14d window) — confirmation signal
  sharpe30d: number;       // change30d / volatility30d
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
  const [priceResult, headlines, insiderBuys, analystRatings] = await Promise.all([
    getPriceData(),
    getNewsHeadlines(),
    getInsiderBuys(),
    getAnalystRatings(),
  ]);
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
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

async function fetchQuote(symbol: string): Promise<StockData | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
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
    const monthAgoClose = validCloses[0] ?? price;
    const high52w = meta.fiftyTwoWeekHigh ?? price;
    const change30d = monthAgoClose ? ((price - monthAgoClose) / monthAgoClose) * 100 : 0;
    const vol = annualizedVol(validCloses);

    // 5-trading-day signal (~1 week)
    const closes5d = validCloses.slice(-6); // 5 trading days + anchor
    const fiveDayAgoClose = closes5d[0] ?? monthAgoClose;
    const change5d = fiveDayAgoClose ? ((price - fiveDayAgoClose) / fiveDayAgoClose) * 100 : 0;
    const vol5d = annualizedVol(closes5d);
    const sharpe5d = vol5d > 0 ? change5d / vol5d : 0;

    // 14-calendar-day signal (~10 trading days back in the closes array)
    const closes14d = validCloses.slice(-11); // last 10 trading days + anchor
    const twoWeekAgoClose = closes14d[0] ?? monthAgoClose;
    const change14d = twoWeekAgoClose ? ((price - twoWeekAgoClose) / twoWeekAgoClose) * 100 : 0;
    const vol14d = annualizedVol(closes14d);
    const sharpe14d = vol14d > 0 ? change14d / vol14d : 0;

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
      sharpe30d: vol > 0 ? change30d / vol : 0,
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

  const stocks = stockResults
    .filter((r): r is PromiseFulfilledResult<StockData> => r.status === "fulfilled" && r.value !== null)
    .map((r) => {
      const s = r.value!;
      return {
        ...s,
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
      const earnFlag = s.earningsDate ? ` ⚠EARN ${s.earningsDate.slice(5)}` : "";
      const insFlag = hasInsider(s) ? " ★INS" : "";
      const sect = STOCK_SECTOR[s.symbol] ?? "?";
      return `${s.symbol.padEnd(6)} $${s.price.toFixed(0).padStart(5)} | 1d: ${d1.padStart(7)} | 5d: ${d5.padStart(7)} | α5d: ${alpha5.padStart(7)} | sharpe5: ${sharpe5.padStart(5)} | 14d: ${d14.padStart(8)} | α14d: ${alpha14.padStart(7)} | 30d: ${d30.padStart(8)} | vs52wHigh: ${fromHigh} | ${sect}${earnFlag}${insFlag}${analystFlag(s)}`;
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
        return `  ${s.etf.padEnd(5)} ${s.name.padEnd(13)} 30d: ${d30.padStart(7)} | α30d: ${alpha.padStart(7)} | sharpe: ${sharpe.padStart(5)}${tag}`;
      }).join("\n")
    : "  (unavailable)";

  return `
--- REAL-TIME MARKET DATA (fetched ${data.fetchedAt}) ---

${spyLine}

SECTOR ROTATION (sorted by α30d vs SPY — use this to identify macro tailwinds/headwinds):
${sectorTable}

TOP 10 NEAR-TERM MOMENTUM (sharpe5 = 5d-return / annualized-vol | α5d = alpha vs SPY over 5d):
${top10.map((s) => `${s.symbol} sharpe5=${s.sharpe5d.toFixed(2)} α5d=${s.relStrength5d >= 0 ? "+" : ""}${s.relStrength5d.toFixed(1)}% sharpe14=${s.sharpe14d.toFixed(2)}${hasInsider(s) ? " ★INS" : ""}${analystFlag(s)}`).join(", ")}

BOTTOM 10 (weakest near-term risk-adjusted momentum):
${bottom10.map((s) => `${s.symbol} sharpe5=${s.sharpe5d.toFixed(2)} α5d=${s.relStrength5d >= 0 ? "+" : ""}${s.relStrength5d.toFixed(1)}%`).join(", ")}

FULL TABLE (sorted by 60%×sharpe5 + 40%×sharpe14 | 5d = PRIMARY signal | 14d = confirmation | 30d = trend context | α5d/α14d = vs SPY | sect = sector ETF | ★INS = insider bought | ↑/↓FIRM = analyst upgrade/downgrade | ⚠EARN = earnings within 30d):
Symbol Price  | 1d      | 5d      | α5d     | sharpe5  | 14d      | α14d    | 30d      | vs52wHigh | sect
${momentumTable}
${earningsSection}
${insiderSection}
${analystSection}

RECENT BUSINESS HEADLINES:
${headlines}

--- END MARKET DATA ---
`;
}
