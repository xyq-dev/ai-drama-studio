import { AutoCreationRun } from "../../../../components/auto-creation-run";

export default async function ProjectAutoCreationPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const { projectId } = await params;
  const { run } = await searchParams;
  const selectedRunId = typeof run === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run)
    ? run
    : undefined;
  return <AutoCreationRun key={selectedRunId ?? projectId} projectId={projectId} selectedRunId={selectedRunId} />;
}
