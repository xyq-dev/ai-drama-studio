import { AdminWorkReview } from "../../../../../components/admin-work-review";

export default async function AdminWorkReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <AdminWorkReview key={id} id={id} fromCreator={query.from === "creator"} />;
}
