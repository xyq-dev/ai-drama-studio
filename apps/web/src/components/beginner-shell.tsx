import type { ReactNode } from "react";
import { CreatorShell } from "./creator-shell";

/** Compatibility entry for the five-step pages; the frame is shared by the whole product. */
export function BeginnerShell({ children, active }: { children: ReactNode; active?: string }) {
  return <CreatorShell activePath={active}>{children}</CreatorShell>;
}
