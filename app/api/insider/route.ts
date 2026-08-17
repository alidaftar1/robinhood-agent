import { requireCronAuth } from "@/lib/auth";
import { refreshInsiderCache } from "@/lib/insider";

export const maxDuration = 300;

export async function GET(request: Request) {
  const unauth = requireCronAuth(request);
  if (unauth) return unauth;
  try {
    const data = await refreshInsiderCache();
    const symbolsWithBuys = Object.keys(data).length;
    const totalBuys = Object.values(data).reduce((sum, buys) => sum + buys.length, 0);
    console.log("INSIDER_CACHE_REFRESH", { symbolsWithBuys, totalBuys });
    return Response.json({ success: true, symbolsWithBuys, totalBuys });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("INSIDER_CACHE_ERROR", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
