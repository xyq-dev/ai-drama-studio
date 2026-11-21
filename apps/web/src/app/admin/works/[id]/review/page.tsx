"use client";

import { useParams } from "next/navigation";
import { AdminWorkReview } from "../../../../../components/admin-work-review";

export default function AdminWorkReviewPage() {
  const params = useParams<{ id: string }>();
  return <AdminWorkReview id={params.id} />;
}
