import { Workbench } from "../../../components/workbench";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <Workbench projectId={projectId} />;
}
