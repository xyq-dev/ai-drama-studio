import { AccountPlanPanel } from "../../components/account-plan-panel";
import { CreatorShell } from "../../components/creator-shell";

export default function AccountPage() {
  return <CreatorShell>
    <AccountPlanPanel />
  </CreatorShell>;
}
