import { DashboardView } from "../dashboard-view";

// Public, keyless share view. Reuses the exact dashboard body (DashboardView) with
// isPublic=true, which hides the account number and adds a public tagline. The page
// output contains no secrets (verified: no API keys, CRON_SECRET, or links with keys).
// force-dynamic so it reflects the latest run on each visit rather than a build-time snapshot.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Robinhood AI Agent — live performance vs the S&P 500",
  description:
    "A real-money AI trading agent (Claude) that trades a Robinhood account autonomously every weekday and benchmarks itself against the S&P 500. Updates each trading day.",
};

export default async function PublicDashboard() {
  return <DashboardView isPublic />;
}
