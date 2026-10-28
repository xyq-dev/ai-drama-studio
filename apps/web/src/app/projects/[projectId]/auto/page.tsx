import { AutoCreationRun } from "../../../../components/auto-creation-run";

export default async function ProjectAutoCreationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <AutoCreationRun projectId={projectId} />;
}
