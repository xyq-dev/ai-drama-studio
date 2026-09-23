import { StatusPage } from "../components/status-page";
import { loadStatusView } from "../lib/load-status";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:3001";
  const environment = process.env.NODE_ENV ?? "development";
  const view = await loadStatusView({ baseUrl, environment });
  return <StatusPage view={view} />;
}
