import { ScriptWorkbench } from "../../../../components/script-workbench";

export default async function ScriptPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ScriptWorkbench key={projectId} projectId={projectId} />;
}
