/** Vite fixture stub. The screenshot harness passes the current admin path as ?path=. */
export function usePathname() {
  if (typeof window === "undefined") return "/admin/works";
  return new URLSearchParams(window.location.search).get("path") || "/admin/works";
}

export function useParams() {
  return { id: "11111111-1111-4111-8111-111111111111" };
}

export function redirect() {}
