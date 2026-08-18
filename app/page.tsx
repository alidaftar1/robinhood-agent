import { cookies } from "next/headers";
import { DashboardView, LoginScreen } from "./dashboard-view";
import { getSessionCookieConfig, touchSession } from "@/lib/dashboard-auth";

// Private dashboard at `/` — gated behind a server-side session (see middleware.ts, which
// creates the session cookie from either a manually-typed key or a single-use email token).
// The public, keyless share view lives at /public and reuses DashboardView.
export default async function DashboardPage() {
  const sessionId = (await cookies()).get(getSessionCookieConfig().name)?.value;
  const authed = sessionId ? await touchSession(sessionId) : false;
  if (!authed) return <LoginScreen />;
  return <DashboardView />;
}
