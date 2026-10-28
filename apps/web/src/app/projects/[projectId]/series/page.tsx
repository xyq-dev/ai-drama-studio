import { SeriesWritingPage } from "../../../../components/series-writing-page";

export default async function ProjectSeriesWritingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SeriesWritingPage projectId={projectId} />;
}
