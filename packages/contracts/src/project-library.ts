export interface ProjectLibraryScript {
  title: string | null;
  source: "ai" | "manual" | "unknown";
  providerKey: string | null;
  model: string | null;
  /** Which existing view can open the saved draft, if any. */
  destination: "auto" | "script" | null;
}
