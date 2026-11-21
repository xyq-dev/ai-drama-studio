import { redirect } from "next/navigation";

/** Old text-model entry. The feature card is the only configuration surface. */
export default function AdminModelsPage() {
  redirect("/admin/features?feature=writing");
}
