import { BeginnerFlow } from "../../../../components/beginner-flow";

export default async function ProjectCreatePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <BeginnerFlow projectId={projectId} />;
}
