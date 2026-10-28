import { TitleWritingRun } from "../../../../components/title-writing-run";

export default async function ProjectWritingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <TitleWritingRun projectId={projectId} />;
}
