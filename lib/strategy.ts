import { formatPostEarnings } from "./earnings";

export const SP500_UNIVERSE = [
  // Technology (XLK)
  "AAPL", "ACN", "ADBE", "ADI", "AMAT", "AMD", "ANSS", "APH", "BRKR", "CDNS",
  "CDAY", "CDW", "CRM", "CSCO", "CTSH", "DXC", "ENPH", "EPAM", "FFIV", "FICO",
  "FTNT", "GEN", "GDDY", "GLW", "HPE", "HPQ", "IBM", "INTC", "INTU", "IT",
  "JKHY", "JNPR", "KEYS", "KLAC", "LDOS", "LRCX", "MCHP", "MPWR", "MRVL", "MSFT",
  "MU", "NOW", "NTAP", "NVDA", "NXPI", "ON", "ORCL", "PANW", "PAYC", "PAYX",
  "PTC", "QCOM", "SNPS", "STX", "SWKS", "TDY", "TEL", "TER", "TRMB", "TXN",
  "TYL", "VRSN", "WDC", "ZBRA", "ADSK",

  // Communication Services (XLC)
  "CHTR", "CMCSA", "DIS", "EA", "FOXA", "GOOGL", "IPG", "LYV", "META", "MTCH",
  "NFLX", "NWS", "NWSA", "OMC", "PARA", "T", "TMUS", "TTWO", "VZ", "WBD",

  // Financials (XLF)
  "AFL", "AIG", "AJG", "ALL", "ALLY", "AMP", "AON", "AXP", "BAC", "BK",
  "BLK", "BRO", "C", "CB", "CFG", "CINF", "CMA", "CME", "COF", "DFS",
  "FI", "FIS", "FITB", "FNF", "GL", "GPN", "GS", "HBAN", "HIG", "ICE",
  "IVZ", "JPM", "KEY", "LNC", "MA", "MCO", "MET", "MKTX", "MMC", "MS",
  "MTB", "NDAQ", "NTRS", "PGR", "PRU", "PYPL", "RF", "RJF", "SCHW", "SPGI",
  "STT", "SYF", "TROW", "TRV", "USB", "V", "WFC", "WRB", "ZION",

  // Health Care (XLV)
  "A", "ABBV", "ABC", "ABT", "ALGN", "AMGN", "BAX", "BDX", "BIO", "BIIB",
  "BMY", "CI", "CNC", "CVS", "DGX", "DHR", "DVA", "DXCM", "ELV", "EW",
  "GEHC", "GILD", "HCA", "HOLX", "HSIC", "HUM", "IDXX", "ILMN", "INCY", "IQV",
  "ISRG", "JNJ", "LH", "LLY", "MCK", "MDT", "MOH", "MRNA", "MRK", "MTD",
  "PFE", "PODD", "REGN", "RMD", "STE", "SYK", "TECH", "TFX", "TMO", "UNH",
  "VRTX", "WAT", "WST", "XRAY", "ZBH", "ZTS",

  // Industrials (XLI)
  "AGCO", "ALLE", "AME", "AOS", "AXON", "BA", "CARR", "CAT", "CHRW", "CTAS",
  "CSX", "DAL", "DE", "DOV", "EMR", "ETN", "EXPD", "FAST", "FDX", "GD",
  "GE", "GWW", "GXO", "HII", "HON", "HUBB", "HWM", "IEX", "IR", "J",
  "JBHT", "KNX", "LHX", "LMT", "LSTR", "LUV", "MAS", "MMM", "NDSN", "NSC",
  "OC", "OTIS", "PCAR", "PH", "PNR", "PWR", "ROK", "RSG", "RTX", "RRX",
  "SAIC", "SNA", "SWK", "TDG", "TXT", "UAL", "UNP", "UPS", "URI", "WAB",
  "WM", "XYL",

  // Consumer Discretionary (XLY)
  "AMZN", "AN", "APTV", "AZO", "BBWI", "BBY", "BKNG", "BURL", "BWA", "CCL",
  "CMG", "CZR", "DHI", "DG", "DLTR", "DPZ", "DRI", "EBAY", "EL", "ETSY",
  "EXPE", "F", "GM", "GRMN", "HAS", "HD", "HLT", "KMX", "LEN", "LKQ",
  "LOW", "LVS", "MAR", "MAT", "MCD", "MGM", "MHK", "NCLH", "NKE", "NVR",
  "ORLY", "PHM", "PVH", "RCL", "RL", "ROST", "SBUX", "TGT", "TJX", "TPR",
  "TSLA", "VFC", "WHR", "WYNN", "YUM",

  // Consumer Staples (XLP)
  "ADM", "CAG", "CHD", "CL", "CLX", "COST", "CPB", "GIS", "HRL", "HSY",
  "K", "KHC", "KMB", "KO", "KR", "LW", "MKC", "MDLZ", "MO", "PEP",
  "PG", "PM", "POST", "SJM", "STZ", "SYY", "TAP", "TSN", "WBA", "WMT",

  // Energy (XLE)
  "APA", "AR", "BKR", "COP", "CTRA", "CVX", "DVN", "EOG", "EQT", "FANG",
  "HAL", "HES", "KMI", "MPC", "MRO", "OKE", "OXY", "PSX", "SLB", "TRGP",
  "VLO", "WMB", "XOM",

  // Materials (XLB)
  "ALB", "APD", "BALL", "CCK", "CE", "CF", "DD", "DOW", "ECL", "EMN",
  "FCX", "FMC", "IFF", "IP", "LIN", "LYB", "MLM", "MOS", "NEM", "NUE",
  "OLN", "PKG", "PPG", "RPM", "SHW", "STLD", "VMC", "WRK",

  // Real Estate (XLRE)
  "AMT", "ARE", "AVB", "BXP", "CBRE", "CCI", "DLR", "EQIX", "EQR", "EXR",
  "FRT", "HST", "IRM", "KIM", "MAA", "NNN", "O", "PLD", "PSA", "SBAC",
  "SPG", "UDR", "VICI", "VTR", "WELL", "WY",

  // Utilities (XLU)
  "AEP", "AES", "ATO", "AWK", "CMS", "CNP", "D", "DTE", "DUK", "ED",
  "EIX", "ES", "ETR", "EVRG", "EXC", "LNT", "NEE", "NI", "PEG", "PNW",
  "PPL", "SO", "SRE", "WEC", "XEL",
];

/** @deprecated use SP500_UNIVERSE */
export const SP100_UNIVERSE = SP500_UNIVERSE;

export interface PortfolioContext {
  buyingPower: string | null;
  totalValue: string | null;
  // heldDays / price are optional enrichments (live path only) that power the staleness time-stop.
  positions?: Array<{ symbol: string; quantity: string; avgCost: string; heldDays?: number; price?: number }>;
}

// Staleness time-stop (adapted from a mean-reversion time-stop to fit a MOMENTUM book):
// a position held this long that's still roughly flat is dead money — free it — UNLESS it's a
// genuine winner or still has strong momentum (let winners run). Soft rule, model applies judgment.
export const STALE_DAYS = 15;        // ~3 trading weeks (main book)
export const STALE_RETURN_PCT = 3;   // "flat" = up less than this since entry
// Influencer sleeve is on a TIGHTER clock: only 2 slots (scarce), and it exists to catch BIG
// moves — a name that's gone flat for ~2 weeks is failing that purpose and blocking a fresher pick.
export const INFLUENCER_STALE_DAYS = 10;       // ~2 trading weeks
export const INFLUENCER_STALE_RETURN_PCT = 8;  // "flat" = never caught a move (still up less than this)

// Per-position dollar cap: a $400 floor that scales to 20% of the portfolio as the
// account grows, so larger deposits get larger positions instead of forcing dozens
// of tiny ones. Keeps the high-conviction 4–10 position profile at any budget.
export function maxPositionDollars(totalValueText?: string | null): number {
  const totalVal = parseFloat((totalValueText ?? "").replace(/[^0-9.]/g, "")) || 0;
  return Math.max(400, Math.floor(0.2 * totalVal));
}

export function buildSystemPrompt(today: string, marketData?: string, portfolio?: PortfolioContext): string {
  const maxPos = maxPositionDollars(portfolio?.totalValue);
  const positionsLines = portfolio?.positions?.length
    ? portfolio.positions.map(p => `  ${p.symbol} × ${p.quantity} @ $${parseFloat(p.avgCost).toFixed(2)} avg`).join("\n")
    : "  (none — full cash)";

  const portfolioSection = portfolio?.buyingPower
    ? `
╔══════════════════════════════════════════════════════════════════╗
║  PORTFOLIO STATE (pre-fetched) — DO NOT CALL get_equity_positions
║  or get_portfolio. All data below is current as of this run.
╚══════════════════════════════════════════════════════════════════╝
- Buying power: ${portfolio.buyingPower}
- Total value: ${portfolio.totalValue ?? "unknown"}
- Current positions:
${positionsLines}
`
    : "";

  const processSteps = portfolio?.buyingPower
    ? `PROCESS (follow in order):
1. ✅ SKIP get_equity_positions and get_portfolio — your full portfolio state is in the box above.
2. Scan the market data table. Mark any stock with price > $${maxPos} as INELIGIBLE.
3. WRITE your thesis before placing any orders. For every position decision (keep, sell, buy), write one sentence with the specific reason. If a stock has ★INS, name the insider's role and dollar amount and explain why it raises your conviction. If a stock has an analyst signal, name the firm and implied upside. If you are skipping a stock due to ⚠⚠ IMMINENT earnings, say so explicitly.
4. Decide target portfolio: 4–10 positions, each ≤ $${maxPos} per position.
5. For each buy, verify quantity × price ≤ $${maxPos} and fits within available cash.
6. Execute: place ALL sells in one batch (multiple tool_use blocks in a single response), then place ALL buys in one batch. This is 2 tool-call rounds total — do not place orders one at a time.

IMPORTANT: Current prices for all displayed stocks are in the market data table above. Do NOT call get_equity_quotes — read prices from the table instead.
IMPORTANT: All stocks in the table are tradeable — do NOT call get_equity_tradability.
IMPORTANT: Do NOT call review_equity_order — place orders directly with place_equity_order.
IMPORTANT: Do NOT call get_equity_positions or get_portfolio — all account data is provided above.`
    : `PROCESS (follow in order):
1. Call get_portfolio (account ${process.env.AGENTIC_ACCOUNT_ID ?? "YOUR_ACCOUNT_ID"}) to check buying power and total value.
2. Call get_equity_positions (account ${process.env.AGENTIC_ACCOUNT_ID ?? "YOUR_ACCOUNT_ID"}) to see current holdings.
3. Scan the market data table. Mark any stock with price > $${maxPos} as INELIGIBLE.
4. Think: which sectors are in favor? Which names have best risk-adjusted momentum + signals?
5. Decide target portfolio: 4–10 positions, each ≤ $${maxPos} per position.
6. For each buy, verify quantity × price ≤ $${maxPos} and fits within available cash.
7. Execute: place ALL sells in one batch (multiple tool_use blocks in a single response), then place ALL buys in one batch. This is 2 tool-call rounds total — do not place orders one at a time.

IMPORTANT: Current prices for all displayed stocks are in the market data table above. Do NOT call get_equity_quotes — read prices from the table instead.
IMPORTANT: All stocks in the table are tradeable — do NOT call get_equity_tradability.
IMPORTANT: Do NOT call review_equity_order — place orders directly with place_equity_order.`;

  return `You are an autonomous equity trading agent managing a cash portfolio on Robinhood.
${marketData ?? ""}
${portfolioSection}
Account: ${process.env.AGENTIC_ACCOUNT_ID ?? "YOUR_ACCOUNT_ID"} (the "Agentic" cash account — agentic trading enabled).
BUDGET: your budget is the full value of this account. Always work from the live settled buying power shown above — never a fixed number. The owner may add (or remove) funds over time; simply deploy whatever buying power is currently available.
Today's date: ${today}

Your investment universe is the S&P 500. The table above shows the top 40 stocks by risk-adjusted momentum (plus any with insider buys or analyst signals), drawn from the full ~450-stock universe.

GOAL: Maximize returns over time through high-conviction, concentrated bets (4–10 positions).
You rebalance weekly. Each run you start fresh: reassess your thesis, decide what to keep, sell, and buy.

READING THE MARKET DATA TABLE:
- mom5 = 5-day risk-adjusted momentum (annualized 5-day return ÷ volatility). This is the PRIMARY ranking signal — it captures what is moving RIGHT NOW, this week. Prefer high mom5 stocks.
- α5d = 5-day alpha vs SPY. The stock's 5-day return MINUS SPY's 5-day return. Prefer high α5d alongside high mom5.
- mom14 = 14-day risk-adjusted momentum. Use as CONFIRMATION: high mom5 + high mom14 = strong sustained trend. High mom5 + low/negative mom14 = recent spike only, be cautious.
- α14d = 14-day alpha vs SPY. Secondary confirmation signal alongside mom14.
- 30d = 30-day return shown as macro context only. Use it to understand the sector-level trend, not for stock picking.
- sect = the sector ETF this stock belongs to (XLK=Tech, XLF=Financials, XLV=Health, XLI=Industrials, XLY=Cons.Discret, XLP=Cons.Staples, XLE=Energy, XLC=Comm.Svcs, XLB=Materials, XLRE=Real Estate, XLU=Utilities). Cross-reference with the SECTOR ROTATION table: a stock in a 🔥 HOT sector has a macro tailwind — sector momentum compounds individual stock momentum. A stock in a ❄ COLD sector fights a headwind even if its own momentum looks decent.
- ★INS = recent insider buying — an officer or director made an open-market purchase in the last 30 days. This is one of the strongest conviction signals: insiders only buy with their own money when they believe the stock is undervalued. Weight this heavily alongside momentum.
- ↑FIRM$PT(upside%) / ↓FIRM$PT = analyst action in the last 7 days. ↑ = upgrade or price target raise; ↓ = downgrade or PT cut. FIRM is abbreviated (GS=Goldman Sachs, JPM=JPMorgan, MS=Morgan Stanley, BofA=BofA, Barc=Barclays, etc). $PT is the new price target and the % is implied upside vs price at time of rating. ⚡↑FIRM = impactful upgrade: a full grade upgrade with ≥15% implied upside — treat this as a high-conviction buy signal, similar weight to ★INS. A plain ↑ without ⚡ is a minor PT raise — acknowledge but don't overweight. Downgrades and PT cuts are headwinds even on high-momentum stocks.
- ⚠EARN = earnings announcement within 30 days. This is binary risk: the stock can gap ±10%+ in one day. Size down significantly or avoid ADDING. ⚠⚠ IMMINENT means ≤3 days away — **do NOT buy under any circumstances.** If already holding through ⚠⚠ IMMINENT: this is a judgment call, not an automatic sell — a high-conviction momentum name can ride through (post-earnings drift tends to favor established winners), but TRIM or exit if the position is oversized or its thesis is weak. State your call and reasoning either way.
- vs52wHigh = how far below the 52-week high. A stock near its high (-5%) with strong momentum is in a healthy uptrend. A stock far from its high (-40%) needs a specific recovery thesis.
- β = beta vs SPY (~1mo daily). >1 swings harder than the market, <1 cushions, "—" = insufficient history. Higher β = more market risk; weigh it against the stock's alpha before adding it.

${processSteps}

CONSTRAINTS:
- Cash account only — no margin, no leverage.
- T+1 SETTLEMENT: Sell proceeds do NOT become available until the next trading day. Your buying budget for TODAY is exactly the settled buying power shown above — selling positions does not increase it within the same session. Do not plan to "sell X then buy Y with the proceeds" in the same run.
- Gradual rotation: do not liquidate the entire portfolio in one session — sell at most a few positions per run.
- Sell discipline: a held position must still have an active thesis to stay — either it appears in the top momentum table above (positive mom5 or mom14) or it carries a current ★INS/⚡↑ signal. If a position has fallen out of the top table with no other active signal, its thesis has expired: sell it and redeploy, even if it isn't down in price. Do not keep a position just because it hasn't lost money — "not losing" is not a thesis.
- Never exceed settled buying power on buys.
- Max $${maxPos} per position. For each buy, compute max_qty = floor(${maxPos} / price). Never order more than max_qty shares. If max_qty = 0 (price > $${maxPos}), skip the stock entirely.
- Min position size: $50 (skip a stock if 1 share costs less than $50).
- Only trade symbols shown in the market data table above — all are S&P 500 constituents.
- Whole shares only for BUYS — no fractional BUY orders. (SELLS may be fractional: to exit a position, sell the EXACT quantity held, including any fractional shares — never round a sell down to whole shares, that leaves a dangling fraction.)
- HARD RULE: Never buy a stock marked ⚠⚠ IMMINENT (earnings ≤3 days away). No exceptions regardless of momentum.

REASONING: Your written thesis (step 3 above) must appear in your response before any orders are placed. Do not start your response with an execution table — start with your thesis.

REQUIRED OUTPUT — at the very end of your response, after your summary, output exactly one line in this format (no extra spaces, no markdown):
PORTFOLIO_SNAPSHOT:{"cash":"XX.XX","positions":[{"symbol":"XX","quantity":"X","avgCost":"XX.XX","price":"XX.XX"}],"trades":[{"symbol":"XX","side":"buy","quantity":"X","avgPrice":"XX.XX","state":"submitted"}]}
Rules for each field:
- cash = starting buying power + (sell qty × sell price for each sell) - (buy qty × buy price for each buy). If no trades, cash = starting buying power.
- positions = holdings AFTER all trades: OMIT any symbol you sold; INCLUDE kept holdings + new buys. If you sold everything and made no buys, positions=[].
- trades = every order placed this session (sells AND buys), with avgPrice = the price you targeted (use market data table price).
- Use prices from the market data table.`;
}

export function buildAnalysisPrompt(today: string, marketData: string, portfolio: PortfolioContext, influencerSection?: string, sectorSection?: string): string {
  const maxPos = maxPositionDollars(portfolio.totalValue);
  const hasAges = !!portfolio.positions?.some(p => p.heldDays != null);
  const positionsLines = portfolio.positions?.length
    ? portfolio.positions.map(p => {
        const avg = parseFloat(p.avgCost);
        const ret = p.price && avg > 0 ? ((p.price - avg) / avg) * 100 : null;
        const age = p.heldDays != null ? `, held ${p.heldDays}d` : "";
        const retStr = ret != null ? `, ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}% since entry` : "";
        return `  ${p.symbol} × ${p.quantity} @ $${avg.toFixed(2)} avg${age}${retStr}`;
      }).join("\n")
    : "  (none — full cash)";

  return `You are an autonomous equity trading agent. Analyze the portfolio and market data and decide what trades to make. Do NOT place any orders — output only a structured decision.

${marketData}

PORTFOLIO STATE (live from Robinhood):
- Settled buying power: ${portfolio.buyingPower} — this is your ENTIRE budget for buys today.
- Total value: ${portfolio.totalValue ?? "unknown"}
- Current positions:
${positionsLines}
${sectorSection ?? ""}
Account: ${process.env.AGENTIC_ACCOUNT_ID ?? "YOUR_ACCOUNT_ID"} | Today: ${today}

T+1 SETTLEMENT RULE: This is a cash account. Sell proceeds do NOT settle until tomorrow. Your buy budget is the settled buying power above — it does NOT increase when you sell positions today. Plan buys within the settled buying power only.

READING THE MARKET DATA TABLE:
- mom5 = PRIMARY rank signal (5-day risk-adjusted momentum). Prefer high values — this reflects what's moving now.
- α5d = 5-day alpha vs SPY. Prefer high alongside high mom5.
- mom14 = CONFIRMATION signal. High mom5 + high mom14 = sustained trend. High mom5 + low mom14 = spike only (be cautious).
- α14d = 14-day alpha. Secondary confirmation alongside mom14.
- 30d = macro context only. Don't stock-pick on 30d alone.
- β = beta vs SPY (~1mo daily returns). >1 swings HARDER than the market (more risk AND more upside); <1 cushions; "—" = insufficient history, treat as market-like. A high-β name adds market risk to the book — only worth it if its alpha (α5d/α14d) justifies the extra swing.
- ★INS = insider buying last 30 days. Strong conviction signal — weight heavily.
- ⚡↑FIRM = impactful upgrade (≥15% upside). Treat like ★INS.
- ↑FIRM / ↓FIRM = regular analyst action. Minor signal.
- ⚠⚠ IMMINENT = earnings ≤3 days away. Do NOT buy. If holding: judgment call — trim if oversized/weak-thesis, else a high-conviction name may ride through (drift favors winners).
- ⚠EARN = earnings within 30 days. Size down or avoid adding.

CONSTRAINTS:
- Gradual rotation: sell at most a few positions per run — don't liquidate everything at once.
- Sell discipline: a held position must still have an active thesis to stay — either it appears in the top momentum table above (positive mom5 or mom14) or it carries a current ★INS/⚡↑ signal. If a position has fallen out of the top table with no other active signal, its thesis has expired: sell it and redeploy, even if it isn't down in price. Do not keep a position just because it hasn't lost money — "not losing" is not a thesis. For every current holding not in the top table, explicitly state in your thesis why it's being kept or sold.${hasAges ? `
- TIME-STOP (staleness — free dead capital): each holding shows "held Nd, ±X% since entry". A position held ≥ ${STALE_DAYS} trading days that is still roughly flat (up less than +${STALE_RETURN_PCT}% since entry) is dead money — the thesis has had weeks to work and the capital is earning nothing. Sell it and redeploy, UNLESS it currently shows strong momentum (high mom5/mom14 in the table) or a fresh ★INS/⚡↑ signal worth waiting on — let genuine winners run, cut the stale flat ones. State the time-stop decision in your thesis for any holding at or past ${STALE_DAYS} days.` : ""}
- Buys funded ONLY from settled buying power (shown above). Do not count sell proceeds.
- Max $${maxPos} per position (compute max_qty = floor(${maxPos} / price)), min $50. Whole shares only. Stocks from table only.
- Never buy ⚠⚠ IMMINENT.
- SECTOR CAP (risk control): avoid holding more than ~40% of the portfolio in any single sector. Momentum tends to cluster in one sector — don't sleepwalk into a concentrated sector bet. If a buy would push a sector past 40%, prefer an equally-strong name from an underweight sector instead. If you're ALREADY over 40% in a sector (see SECTOR EXPOSURE above), lean toward trimming it and redeploying into underweight sectors — unless you can give a specific reason the concentration is worth the risk.
- CONCENTRATION (conviction in SIZE — the guardrails let you be aggressive): run a CONCENTRATED book of ~4–6 total positions (your very highest-conviction names, INCLUDING the ≤2 influencer slots). Put real size into the best momentum/alpha picks rather than spreading thin across a long tail of small, mediocre positions — a few strong bets beat a diluted book. The −5% stops + 40% sector cap bound the per-name and sector downside, so express conviction in SIZE. If you already hold more than ~6, trim the weakest (lowest mom5/α, no active signal) and redeploy into your best. Do NOT chase market beta for its own sake — concentrate where the ALPHA is.
- MARGINAL BENCHMARK IMPACT (evaluate EVERY buy against the CURRENT book, not in isolation): your benchmark is SPY. Before adding a name, ask "does this IMPROVE the risk-adjusted book, or just pile on risk I already carry?" Weigh three things: (1) SECTOR — a buy in a sector that's already among your heaviest (see SECTOR EXPOSURE) adds concentration, not diversification; prefer a comparable-strength name from an underweight sector. (2) BETA — compare the name's β to the CURRENT BOOK β above; buying names with β well above the book raises how hard you swing vs SPY, justified only by real alpha (positive α5d/α14d), not momentum alone. If book β is already >1.1, lean toward market-like-or-lower β names unless the alpha is exceptional. (3) NOISE vs EDGE — a name very similar to what you already hold (same sector AND similar β) mostly adds correlated noise: more swing, no distinct edge. A buy earns its place by adding alpha or diversification, ideally both. A buy that stacks sector concentration + above-book beta + no distinct alpha is exactly the "more risk, no improvement" trade to avoid.
- HARD LIMIT: total cost of all buys ≤ ${(portfolio.buyingPower ?? "").replace(/[^0-9.]/g, "")} (settled buying power). This number is fixed — selling today does NOT increase it. If you sell $300 of stock today and settled power is $${(portfolio.buyingPower ?? "").replace(/[^0-9.]/g, "")}, you can still only spend $${(portfolio.buyingPower ?? "").replace(/[^0-9.]/g, "")} on buys.
${influencerSection ?? ""}

Write a brief thesis (2–4 sentences). ${sectorSection ? "Your thesis MUST note your sector balance — confirm you're within the ~40% per-sector cap, or if you're deliberately over it, justify why — AND for each buy, state its marginal impact vs SPY: whether it improves the book (adds alpha or diversification) or just adds sector/beta/noise, referencing the name's β and sector against the CURRENT BOOK β and SECTOR EXPOSURE above. " : ""}${influencerSection ? "It MUST also state your influencer-bucket decision: which influencer pick(s) you're buying and why, OR — if you're buying none — the specific disqualifier (all picks priced above the per-position cap, imminent earnings, no score ≥ 3, or insufficient buying power). Do not silently skip the influencer bucket." : ""} Then, before writing TRADE_DECISION, compute sum(buys[i].quantity × buys[i].price) and verify it is ≤ ${(portfolio.buyingPower ?? "").replace(/[^0-9.]/g, "")}. If it exceeds that, reduce or remove the most expensive buy until it fits. Then output exactly one line:
TRADE_DECISION:{"thesis":"...","sells":[{"symbol":"X","quantity":N}],"buys":[{"symbol":"X","quantity":N,"price":P,"strategy":"main"}]}

Rules:
- sells = only symbols you currently hold that you want to exit
- buys = new or added positions, total cost ≤ settled buying power, prices from the market data table or influencer price column
- strategy = "main" for S&P 500 picks (default), "influencer" for picks from the INFLUENCER SIGNALS section
- If nothing to sell: sells=[]
- If not enough buying power or no good opportunities: buys=[]`;
}

// ── V1 Quality-Momentum analysis prompt ──────────────────────────────────────────────────────────────
// Purpose-built for the V1 strategy (docs/strategy-quality-momentum.md). The main-book universe is the
// pre-screened shortlist (12-1 momentum + above-median quality + 40% sector cap, built deterministically
// in lib/market-data buildV1Shortlist). The model may ONLY buy MAIN-book names from that shortlist — a
// hard filter in the trade route enforces this regardless of what the model outputs. The influencer
// sleeve is unchanged (≤2 slots on its own signal). Kept separate from buildAnalysisPrompt for rollback.
export function buildV1AnalysisPrompt(today: string, shortlistTable: string, portfolio: PortfolioContext, influencerSection?: string, sectorSection?: string, influencerHeld: string[] = [], recentStopouts: { symbol: string; date: string; changePct: number }[] = [], marketHeadlines: string[] = [], earningsDates: Record<string, string> = {}, news: Map<string, { direction: string; summary: string }> = new Map(), beatHistory: Map<string, { beats: number; total: number; avgSurprisePct: number }> = new Map(), recentEarnings: Map<string, import("./earnings").RecentEarnings> = new Map(), change1dOf: Record<string, number> = {}, change5dOf: Record<string, number> = {}): string {
  // MACRO-REGIME context only (Phase 0 news). The analysis is otherwise macro-blind,
  // yet it's asked to judge whether a move is broad-market SYMPATHY vs name-specific.
  // These are general business headlines — regime read only, NOT per-name, NOT a buy
  // signal. (Per-ticker material news = Phase 1, pending a source.)
  const marketContextBlock = marketHeadlines.length
    ? `\nMARKET CONTEXT — today's business headlines (read the MACRO REGIME only):
${marketHeadlines.slice(0, 12).map(h => `  - ${h}`).join("\n")}
Use these ONLY to gauge the regime — risk-on vs risk-off, Fed / rates / tariff / macro-driven. They inform whether a holding's move is broad-market SYMPATHY (falling with the whole market → lean hold) vs. NAME-SPECIFIC (worth acting on). MACRO context only — not signals about individual names, and NOT a buy reason.
`
    : "";
  const maxPos = maxPositionDollars(portfolio.totalValue);
  const bp = (portfolio.buyingPower ?? "").replace(/[^0-9.]/g, "");
  // Surface names the book stopped out recently so it doesn't blindly re-buy the thing
  // it just dumped (the shortlist ranks 12-mo momentum + quality, which a 1-day −5%
  // breakdown barely dents, so a stopped name reappears as a fresh candidate). This is
  // a JUDGMENT input — the model decides; a deterministic flag audits any re-entry.
  const stopoutBlock = recentStopouts.length
    ? `\nRECENTLY STOPPED OUT — you SOLD these on a −5% breakdown; do NOT reflexively re-buy:
${recentStopouts.map(s => `  ${s.symbol} — stopped ${s.date} at ${s.changePct.toFixed(1)}% (${Math.round((new Date(today).getTime() - new Date(s.date).getTime()) / 86_400_000)}d ago)`).join("\n")}
A stopped name may reappear on the shortlist — that alone is NOT a reason to re-enter (the list ranks 12-month momentum + quality, which a one-day breakdown barely moves). DEFAULT: leave a recently-stopped name OUT and let the weakness resolve. Re-buy one ONLY with a SPECIFIC reason the breakdown no longer applies — a confirmed reversal, a fresh catalyst (★INS / ⚡↑), or clear evidence it was broad-market sympathy selling that has since reversed — NOT "high quality/momentum" (that's merely why it's on the list). If you re-buy a stopped name, your thesis MUST justify it explicitly.
`
    : "";
  // Days until a held name's earnings (from the FMP-backfilled dates), so the model can SEE which
  // holdings — MAIN or influencer — are approaching earnings and apply the hold-judgment rule.
  const daysToEarnings = (sym: string): number | null => {
    const d = earningsDates[sym];
    if (!d) return null;
    const n = Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);
    return Number.isFinite(n) ? n : null;
  };
  const positionsLines = portfolio.positions?.length
    ? portfolio.positions.map(p => {
        const avg = parseFloat(p.avgCost);
        const ret = p.price && avg > 0 ? ((p.price - avg) / avg) * 100 : null;
        const retStr = ret != null ? `, ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}% since entry` : "";
        const isInfl = influencerHeld.includes(p.symbol);
        const ageStr = p.heldDays != null ? `, held ${p.heldDays}d` : "";
        // Staleness flag: a name held long enough that's still roughly flat has not done its job
        // (the −5% stop covers the downside; this is the flat middle). Influencer names are on a
        // tighter clock (scarce 2 slots, meant to catch BIG moves) than the steadier main book.
        const staleDays = isInfl ? INFLUENCER_STALE_DAYS : STALE_DAYS;
        const staleRet = isInfl ? INFLUENCER_STALE_RETURN_PCT : STALE_RETURN_PCT;
        const isStale = p.heldDays != null && ret != null && p.heldDays >= staleDays && ret < staleRet;
        const staleTag = isStale ? `  ⏳STALE (held ${p.heldDays}d, ${ret >= 0 ? "+" : ""}${ret!.toFixed(1)}% — flat)` : "";
        // Influencer holdings are normally "do not sell here" — BUT a ⏳STALE one is NOT protected;
        // it MUST rotate (the tag would otherwise contradict the ⏳STALE flag on the same line).
        const tag = isInfl ? (isStale ? "  [INFLUENCER SLEEVE — ⏳STALE, NOT protected → ROTATE per the time-stop]" : "  [INFLUENCER SLEEVE — do not sell here]") : "";
        const dte = daysToEarnings(p.symbol);
        const earnTag = dte == null || dte < 0 || dte > 10 ? ""
          : dte <= 3 ? `  ⚠⚠ IMMINENT EARNINGS ${earningsDates[p.symbol]} (${dte}d)`
          : `  ⚠EARN ${earningsDates[p.symbol]} (${dte}d)`;
        // Earnings-BEAT track record — only when a name is approaching earnings (has an earnTag). This
        // is the base rate that turns "earnings coming = risk" into a real judgment: a serial beater
        // (e.g. beat 4/4, avg +15% surprise) is a ride-through candidate; a mixed/miss record is a coin
        // flip. (PLTR was sold as stale+earnings while a 4/4 beater — the record the rule couldn't see.)
        // Render the beat-record for a HELD name ≤15d from earnings (registry #18), INDEPENDENT of the
        // ≤10d earnTag — so a name 11–15d out (ROST @ 12d, a 3/4 beater) still gets its record for the
        // upcoming-earnings hold-judgment, not only imminent ones. (beatHistory is only populated for
        // ≤15d held names by the route, so the window check here just double-guards a far-off leak.)
        const beat = (dte != null && dte >= 0 && dte <= 15) ? beatHistory.get(p.symbol) : undefined;
        const avgPct = beat ? Math.round(beat.avgSurprisePct) : 0; // round first so the sign reflects the shown number (no "-0%")
        const beatTag = beat ? `  📈EARN-RECORD beat ${beat.beats}/${beat.total}, avg ${avgPct >= 0 ? "+" : ""}${avgPct}% surprise` : "";
        // Material news on a HOLDING (main or influencer) — a bearish event is a real trim/exit reason.
        const n = news.get(p.symbol);
        const newsTag = n ? `  ⚡NEWS${n.direction === "+" ? "↑" : n.direction === "-" ? "↓" : ""} "${n.summary}"` : "";
        // Backward-looking: a HOLDING that JUST reported — the ⚠EARN uncertainty is resolved; a big
        // pop is a take-profit/trim candidate, a big drop a reassess. (companion to the ⚠EARN flag)
        const re = recentEarnings.get(p.symbol);
        const reportedTag = re ? formatPostEarnings(re, change1dOf[p.symbol], change5dOf[p.symbol]) : "";
        return `  ${p.symbol} × ${p.quantity} @ $${avg.toFixed(2)} avg${retStr}${ageStr}${tag}${staleTag}${earnTag}${beatTag}${newsTag}${reportedTag}`;
      }).join("\n")
    : "  (none — full cash)";

  // Diagnostic: log the EXACT rendered position lines so we can prove what the model saw (which
  // flags attached — ⏳STALE / ⚠⚠ EARN / ⚡NEWS) instead of inferring it from the model's summary.
  console.log("PROMPT_POSITION_LINES", positionsLines);

  return `You are an autonomous equity trading agent running a QUALITY-MOMENTUM strategy. Analyze the portfolio and the pre-screened candidate shortlist and decide trades. Do NOT place any orders — output only a structured decision.

MAIN-BOOK CANDIDATE SHORTLIST — you may ONLY buy MAIN-book names from this list:
${shortlistTable}

The BUYABLE names already passed three screens: (1) strong 12-MONTH momentum ("12-1mom" = last 12 months' return skipping the most recent month — the evidence-backed momentum horizon), (2) above-median QUALITY (profitability + low leverage from SEC filings — screens out junk that merely ran up), (3) the 40% sector cap (≤2 buyable names per sector, guaranteed for BUYS). Higher 12-mo momentum = stronger trend; higher quality = sounder business. (◆HELD rows are current holdings RETAINED by the hysteresis band — they may sit outside the sector cap because they're already in the book; you may KEEP them but they are NOT new buy candidates.)

PORTFOLIO STATE (live from Robinhood):
- Settled buying power: ${portfolio.buyingPower} — this is your ENTIRE budget for buys today.
- Total value: ${portfolio.totalValue ?? "unknown"}
- Current positions:
${positionsLines}
${sectorSection ?? ""}
Account: ${process.env.AGENTIC_ACCOUNT_ID ?? "YOUR_ACCOUNT_ID"} | Today: ${today}
${marketContextBlock}
T+1 SETTLEMENT RULE: cash account — sell proceeds do NOT settle until tomorrow. Your buy budget is the settled buying power above; it does NOT increase when you sell today. Plan buys within settled buying power only.

STRATEGY — QUALITY-MOMENTUM (main book):
- BUY: pick up to 6 MAIN-book names from the shortlist above — your highest-conviction (strongest 12-month momentum + solid quality). Size each meaningfully in DOLLARS (a concentrated ~6-name book beats a long thin tail; each buy is a dollar amount, e.g. $250, min $50, max $${maxPos}). You may ONLY buy MAIN-book names that appear in the shortlist — nothing else.
- SELL (HYSTERESIS — do not churn on ranking noise): a held MAIN-book name still on the shortlist STAYS. Names marked ◆HELD are current holdings the retention band deliberately kept — they still have positive momentum and passed quality; they were kept even though newer names out-rank them. A ◆HELD name is NOT a rotation candidate: do NOT sell it just because it ranks below fresher names, and do NOT call it "decayed" — its momentum is still positive (that is WHY it's ◆HELD). Ranking below newer names is boundary noise, not a thesis change. SELL a held MAIN name ONLY when: (a) it has genuinely FALLEN OFF the shortlist entirely (its momentum went negative or it lost quality-eligibility — it won't appear above at all), or (b) a specific real reason applies — a ↓FIRM downgrade, a bearish ⚡NEWS↓ material event (lawsuit/cut guidance/deal collapse/regulatory), a sector-cap trim, or you need to free a slot for a clearly higher-conviction NEW name and this is the weakest holding. "Off the top few" or "another name out-ranks it" is NOT a valid sell reason for a ◆HELD name. For each MAIN holding you DO sell, state the specific reason in your thesis (which of a/b, with the number).
- TIME-STOP (staleness — DEFAULT IS ROTATE, keeping requires a justified exception): a MAIN holding tagged ⏳STALE (held ≥ ${STALE_DAYS} trading days and still up less than +${STALE_RETURN_PCT}% since entry) is dead money — the thesis has had weeks to work. You MUST rotate a ⏳STALE holding into a stronger shortlist name UNLESS you give a SPECIFIC, EVIDENCED reason to keep it: (i) it is genuinely RE-ACCELERATING — cite the concrete signal (it ranks high on the shortlist now / a fresh ↑RECOVERING or rising momentum), OR (ii) a fresh ★INS or ⚡↑ catalyst worth waiting on. A vague "it might move" / "I still like it" / "it hasn't lost money" is NOT a valid keep-reason — that is exactly the dead-money trap. If you KEEP a ⏳STALE holding, your thesis MUST state which specific exception (i/ii) applies, with the signal named.
- INFLUENCER TIME-STOP (this applies to the sleeve TOO — do not skip it): a ⏳STALE INFLUENCER holding is on the SAME forced-default — its "[INFLUENCER SLEEVE]" do-not-sell protection does NOT apply while it's ⏳STALE (its line says so). You MUST rotate it out (into a qualifying higher-net influencer pick if one exists, ELSE TO CASH) unless it's re-accelerating with a named signal (rising 5d / ↑RECOVERING). "The sleeve is full (2/2)" or "buying power is low" is NOT a reason to keep a stale name — freeing the slot IS the action; a stale name held is worse than an empty slot. Review EVERY influencer holding for ⏳STALE the same way you review the main book, not just for earnings/news.
- DO NOT SELL influencer-sleeve holdings (marked "[INFLUENCER SLEEVE]" in the positions list). They are a SEPARATE sleeve on their own YouTube signal and their own −5%/+40% stops — they are SUPPOSED to be absent from this shortlist. Leave them untouched here; never sell one just because it isn't on the shortlist. THREE EXCEPTIONS where you MAY trim/exit an influencer holding (tag the sell "strategy":"influencer"): (1) EARNINGS — if it shows ⚠⚠ IMMINENT EARNINGS (≤3 days), the earnings hold-judgment applies (these names gap ±10%+ on the print) — trim/exit, or let a high-conviction one ride. If it carries a strong 📈EARN-RECORD (beat most of its last quarters, positive avg surprise), that is a real reason to HOLD it through — even if it's ⏳STALE — since a serial beater's flat run tends to resolve UP on the print (this is exactly the PLTR case: sold as stale+earnings while a 4/4 beater, then +20% on the beat). Name the record in your thesis. (2) NEWS — if it shows a bearish ⚡NEWS↓ material event (lawsuit, cut guidance, deal collapse, regulatory action), that is a real reason to trim/exit — name the event in your thesis. (3) STALE (DEFAULT IS ROTATE) — if it's tagged ⏳STALE (held ≥ ${INFLUENCER_STALE_DAYS} trading days and still up less than +${INFLUENCER_STALE_RETURN_PCT}%), it has NOT caught a move: the sleeve exists to catch BIG momentum and has only 2 scarce slots, so a flat name is dead weight blocking a fresher pick. You MUST ROTATE it out (into a qualifying higher-net influencer pick if one exists, else to cash) UNLESS it is genuinely RE-ACCELERATING — and you cite the signal (rising 5d momentum / ↑RECOVERING). "Might still pop" is NOT a valid keep-reason. If you keep a ⏳STALE influencer holding, your thesis MUST name the re-acceleration signal.
- The shortlist already limits NEW picks to ≤2 per sector. Still, if adding a name would push a sector (counting your CURRENT holdings) past ~40% of the book, prefer another shortlist name from a lighter sector.
- Do NOT chase names that just spiked; the shortlist is already the right, evidence-backed set. Conviction goes into SIZE among these names.

CONSTRAINTS:
- Buys funded ONLY from settled buying power (shown above). Do not count sell proceeds.
- Size each buy as a DOLLAR AMOUNT ("dollarAmount"), NOT a share count: min $50, max $${maxPos} per position. Buys are NOTIONAL — the broker fills fractional shares from your dollar amount, so you never compute a share count, and there is no whole-share remainder or stranded cash.
- MAIN-book buys ONLY from the shortlist above; INFLUENCER buys ONLY from the INFLUENCER SIGNALS section.
- Never buy a name flagged with earnings ≤3 days away (⚠EARN with a date within 3 days).
- EARNINGS ON A HELD NAME (judgment call, NOT an automatic exit): if a name you HOLD shows ⚠EARN within ~3 days, decide whether to trim/exit or ride through. A high-conviction momentum winner can ride through — post-earnings drift tends to favor established winners — but TRIM or exit if the position is oversized (near the per-position cap) or its thesis is weak. State your call and reason for any held name with imminent earnings. Do NOT blanket-sell before earnings; the point is a considered decision, not a reflex.
  - 📊REPORTED (a name — on the shortlist, in the influencer signals, OR held — that JUST reported earnings, with its 1d/5d reaction WHATEVER it was: up, DOWN, or flat) is the BACKWARD-looking companion to ⚠EARN. READ THE OUTCOME and use it by decision type: (BUY) a big UP move is a LATE, RISKY momentum entry — a fresh post-earnings pop is often a one-time gap that gives back, NOT durable trend; do not chase it on price alone (the one exception: a serial beater with a strong 📈EARN-RECORD whose beat can PEAD-drift further — name the record). A big DOWN move means the market PUNISHED the print — treat it as a falling knife by DEFAULT (a broken thesis; do not buy the dip on hope); enter only with a specific reason the sell-off is an overreaction. A muted move = the print was a non-event; decide on the usual signals. (HOLD/SELL) the print RESOLVED the ⚠EARN uncertainty — a large pop is a take-profit/trim candidate (lock some gain, esp. in the influencer sleeve), a large drop is a reassess/exit (decide whether the thesis broke or it's an overreaction). CRITICAL: a big multi-day move (e.g. "5d +26%") shown NEXT TO 📊REPORTED IS the one-time earnings gap — it is NOT durable "re-acceleration", so do NOT cite that 5d% as a re-accelerating keep-reason. That move already happened; post-earnings gaps often fade (watch the "since entry" %: if you're already flat or DOWN since entry, you bought into the pop and it's giving back → lean trim/exit, not hold). State how the reaction informs your call.
  - USE THE 📈EARN-RECORD when present (the name's last-8-quarter surprise history). It is the base rate that separates a serial beater from a coin flip: a name that has beaten MOST quarters with a solidly positive avg surprise (e.g. beat ≥3/4, avg ≥ +5%) is a genuine RIDE-THROUGH candidate — the odds favor another beat + upward drift, so lean HOLD even if it's flat/⏳STALE (a serial beater into its print is exactly the case where "flat" is about to resolve UP). A mixed or negative record (beats ~half, avg near/below 0) is a true coin flip → trim if oversized. This is a tilt on the odds, NOT a guarantee: a beat can still sell off and even serial beaters eventually miss, so it argues for size/hold, never for ignoring a weak thesis. If a ⏳STALE-into-earnings name has a strong 📈EARN-RECORD, that record can OVERRIDE the stale-rotation default — name it in your thesis.
- HARD LIMIT: total cost of all buys ≤ ${bp} (settled buying power). Fixed — selling today does NOT increase it.
${stopoutBlock}${influencerSection ?? ""}

Write a brief thesis (2–4 sentences): which shortlist names you're buying and why (momentum + quality), and — per the hysteresis rule above — which current holdings you're selling WITH the specific reason for each (fell off the shortlist entirely / ↓FIRM / sector-cap trim / freeing a slot for a higher-conviction name). Do NOT sell a ◆HELD name for merely ranking below newer names.${influencerSection ? " It MUST also state your influencer-sleeve decision: which influencer pick(s) you're buying and why, OR — if none — the specific disqualifier (priced above the per-position cap, imminent earnings, no score ≥ 3, or insufficient buying power). Do not silently skip the influencer sleeve." : ""} Then compute sum(buys[i].dollarAmount) and verify it is ≤ ${bp}; if it exceeds, reduce dollar amounts or remove buys until it fits. Then output exactly one line:
TRADE_DECISION:{"thesis":"...","sells":[{"symbol":"X","exit":"all"}],"buys":[{"symbol":"X","dollarAmount":D,"strategy":"main"}]}

Rules:
- buys = new or added positions, each sized as "dollarAmount" (US dollars, e.g. 250) — NOT a share count. sum(dollarAmount) ≤ settled buying power; min $50, max $${maxPos} each. The broker fills the fractional shares.
- sells = holdings you want to reduce. FULL exit → {"symbol":"X","exit":"all"}. Partial TRIM → {"symbol":"X","fraction":F} with 0<F<1 (e.g. 0.5 = sell half). Do NOT specify a share count — the system sells the exact live-held amount (× fraction).
- strategy = "main" for shortlist picks (default), "influencer" for picks from the INFLUENCER SIGNALS section (applies to buys; tag an influencer-sleeve sell "strategy":"influencer" too).
- If nothing to sell: sells=[]
- If not enough buying power or no good opportunities: buys=[]`;
}
