import type { ReactNode } from "react";
import { CreatorShell } from "./creator-shell";

/** Compatibility entry for the five-step pages; the frame is shared by the whole product. */
export function BeginnerShell({ children, active, workspaceNavigation, headerContent }: {
  children: ReactNode;
  active?: string;
  workspaceNavigation?: ReactNode;
  headerContent?: ReactNode;
}) {
  return <CreatorShell activePath={active} workspaceNavigation={workspaceNavigation} headerContent={headerContent}>{children}</CreatorShell>;
}
