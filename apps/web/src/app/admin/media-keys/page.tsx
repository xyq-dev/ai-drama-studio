import { redirect } from "next/navigation";

/** Old media-key entry. Storyboard configuration replaces it. */
export default function AdminMediaKeysPage() {
  redirect("/admin/features?feature=storyboard");
}
