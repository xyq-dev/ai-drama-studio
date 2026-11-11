import { ScriptWorkbench } from "../../../../components/script-workbench";

export default async function ScriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ history?: string | string[] }>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const initialHistory =
    typeof query.history === "string" && /^[0-9a-f-]{36}$/i.test(query.history)
      ? query.history
      : undefined;
  return <ScriptWorkbench key={projectId} projectId={projectId} initialHistory={initialHistory} />;
}
