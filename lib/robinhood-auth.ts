const TOKEN_ENDPOINT = "https://api.robinhood.com/oauth2/token/";
const CLIENT_ID = "LtLiNmbs9owbYfWgBlC68Z2V-claude"; // public Robinhood MCP OAuth client
const REDIS_KEY = "robinhood:tokens";
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID ?? "";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID ?? "";
const BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function redisGet(key: string): Promise<StoredTokens | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json() as { result: string | null };
    if (!json.result) return null;
    return JSON.parse(json.result) as StoredTokens;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: StoredTokens): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
  } catch {
    console.warn("Upstash write failed — tokens not persisted");
  }
}

async function vercelUpdateTokens(tokens: StoredTokens): Promise<void> {
  const vercelToken = process.env.VERCEL_TOKEN;
  if (!vercelToken) return;
  try {
    const listRes = await fetch(
      `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env?teamId=${VERCEL_TEAM_ID}`,
      { headers: { Authorization: `Bearer ${vercelToken}` }, signal: AbortSignal.timeout(10000) }
    );
    if (!listRes.ok) return;
    const { envs } = await listRes.json() as { envs: Array<{ id: string; key: string }> };
    const updates: Record<string, string> = {
      ROBINHOOD_ACCESS_TOKEN: tokens.accessToken,
      ROBINHOOD_REFRESH_TOKEN: tokens.refreshToken,
      ROBINHOOD_TOKEN_EXPIRES_AT: String(tokens.expiresAt),
    };
    await Promise.all(
      envs
        .filter(e => e.key in updates)
        .map(e =>
          fetch(`https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env/${e.id}?teamId=${VERCEL_TEAM_ID}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ value: updates[e.key] }),
            signal: AbortSignal.timeout(10000),
          })
        )
    );
    console.log("VERCEL_TOKENS_UPDATED");
  } catch {
    console.warn("VERCEL_TOKEN_UPDATE_FAILED — tokens still in Redis");
  }
}

export async function getValidAccessToken(): Promise<string> {
  // Check Upstash first
  const stored = await redisGet(REDIS_KEY);
  if (stored && Date.now() < stored.expiresAt - BUFFER_MS) {
    return stored.accessToken;
  }

  // Fall back to env var (first run before Redis is populated)
  const envExpiresAt = parseInt(process.env.ROBINHOOD_TOKEN_EXPIRES_AT ?? "0");
  if (process.env.ROBINHOOD_ACCESS_TOKEN && Date.now() < envExpiresAt - BUFFER_MS) {
    return process.env.ROBINHOOD_ACCESS_TOKEN;
  }

  // Refresh using stored refresh token (prefer Redis, fall back to env)
  const refreshToken = stored?.refreshToken ?? process.env.ROBINHOOD_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("No refresh token available");
  console.log("TOKEN_REFRESH_TRIGGERED");
  return refreshAccessToken(refreshToken);
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: "internal",
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await redisSet(REDIS_KEY, tokens);
  await vercelUpdateTokens(tokens);
  console.log("TOKEN_REFRESHED", { expiresAt: new Date(tokens.expiresAt).toISOString() });

  return tokens.accessToken;
}
