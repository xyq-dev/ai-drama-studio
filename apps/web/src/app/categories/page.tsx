import { redirect } from "next/navigation";

/** Where the old 灵感中心 page lived. Its categories, tags and directions are now the inspiration section of /create. */
const CATEGORIES_REDIRECT = "/create?direction=1#inspiration";

/**
 * Old links and bookmarks land on the inspiration section of the one creation page. The flag only lets that page offer
 * the direction this browser saved in 灵感中心 before; it carries no story text and adds nothing to the draft.
 */
export default function CategoriesPage(): never {
  redirect(CATEGORIES_REDIRECT);
}
