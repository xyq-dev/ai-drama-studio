import { TitleWritingRun } from "../../../../components/title-writing-run";
import { isEntityId } from "../../../../lib/title-writing-client";

export default async function ProjectWritingPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const { projectId } = await params;
  const { run } = await searchParams;
  const selectedRunId = isEntityId(run) ? run : undefined;
  return <TitleWritingRun key={selectedRunId ?? projectId} projectId={projectId} selectedRunId={selectedRunId} />;
}
