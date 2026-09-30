#!/usr/bin/env bash
# Build the Sharadar extracts the backtests read, from the bulk API.
#
#   SHARADAR_API_KEY=... bash scripts/sharadar-extract.sh
#
# Idempotent: skips any extract that already exists and is non-empty, so a warm cache costs nothing.
#
# LICENSING: everything this writes is licensed per-subscriber vendor data. It goes to
# ~/.cache/sharadar — OUTSIDE the repo — so it can never be committed. Do not move it inside the
# working tree, do not upload it as a CI artifact, and do not add it to a container image.
#
# The bulk endpoints 302-redirect to a presigned URL, hence -L. The archives are large (~944MB
# prices, ~631MB fundamentals) so each is streamed through the filter and then deleted, keeping peak
# disk around 1.5GB rather than 5GB.
set -euo pipefail

: "${SHARADAR_API_KEY:?SHARADAR_API_KEY is required}"
API="https://api.sharadar.com/v1.0/data"
DIR="${SHARADAR_CACHE_DIR:-$HOME/.cache/sharadar}"
mkdir -p "$DIR"
cd "$DIR"

have() { [ -s "$1" ]; }

fetch_csv() {  # fetch_csv <table> <outfile> <extra-query>
  local table="$1" out="$2" extra="${3:-}"
  if have "$out"; then echo "  ✓ $out (cached)"; return; fi
  echo "  → $out"
  curl -sS -f -L -H "x-api-key: ${SHARADAR_API_KEY}" \
    "${API}/${table}?format=csv${extra}" -o "$out"
}

fetch_bulk_zip() {  # fetch_bulk_zip <table> <outzip>
  local table="$1" out="$2"
  if have "$out"; then echo "  ✓ $out (cached)"; return; fi
  echo "  → $out (bulk, large)"
  curl -sS -f -L -H "x-api-key: ${SHARADAR_API_KEY}" \
    "${API}/${table}?years=full" -o "$out"
}

echo "[1/5] S&P 500 membership history"
if ! have sp500.csv; then
  fetch_bulk_zip sp500 sp500.csv.zip
  unzip -o -q sp500.csv.zip
  rm -f sp500.csv.zip
fi
echo "  sp500.csv: $(wc -l < sp500.csv) rows"

echo "[2/5] Ticker universe (every name ever in the index, INCLUDING delisted)"
# Delisted tickers carry a suffix (LEHMQ, WB1, SAF2). They must come from this table and never be
# guessed from a modern symbol list, or the failed companies silently vanish from the backtest.
awk -F, 'NR>1 && $3!="" {print $3}' sp500.csv | sort -u > sp500_tickers.txt
echo "  tickers: $(wc -l < sp500_tickers.txt)"

echo "[3/5] SPY benchmark"
# SPY is an ETF, so it lives in `funds` (SFP), NOT `stocks` (SEP). Querying stocks returns an empty
# body with a 200 — which reads exactly like "no data" rather than "wrong table".
fetch_csv funds spy.csv "&ticker=SPY&from=1997-01-01"
echo "  spy.csv: $(wc -l < spy.csv) rows"

echo "[4/5] Daily prices, filtered to index members"
if ! have sp500_prices.csv; then
  fetch_bulk_zip stocks stocks.csv.zip
  unzip -p stocks.csv.zip | awk -F, '
    NR==FNR { T[$1]=1; next }
    FNR==1  { print; next }
    ($1 in T) { print }
  ' sp500_tickers.txt - > sp500_prices.csv
  rm -f stocks.csv.zip
fi
echo "  sp500_prices.csv: $(wc -l < sp500_prices.csv) rows"

echo "[5/5] Fundamentals (as-reported annual AND trailing-twelve-months)"
if ! have sp500_fund_all.csv; then
  fetch_bulk_zip fundamentals fundamentals.csv.zip
  # AR* = as reported. MR* (restated) is deliberately EXCLUDED: it embeds revisions made later, so a
  # restatement that corrected a fraud would retroactively improve quality scores on dates before
  # anyone knew.
  unzip -p fundamentals.csv.zip | awk -F, '
    NR==FNR { T[$1]=1; next }
    FNR==1  { print; next }
    { if (($2=="ARY" || $2=="ART") && ($1 in T)) print }
  ' sp500_tickers.txt - > sp500_fund_all.csv
  rm -f fundamentals.csv.zip
fi
echo "  sp500_fund_all.csv: $(wc -l < sp500_fund_all.csv) rows"

echo
echo "extracts ready in $DIR"
du -sh "$DIR"/*.csv 2>/dev/null | sort -h || true
