import { DashboardView, LoginScreen, isAuthed } from "./dashboard-view";

// Private dashboard at `/` — gated behind the dashboard key (CRON_SECRET).
// The public, keyless share view lives at /public and reuses DashboardView.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  const params = await searchParams;
  if (!isAuthed(params.key ?? null)) return <LoginScreen />;
  return <DashboardView />;
}
