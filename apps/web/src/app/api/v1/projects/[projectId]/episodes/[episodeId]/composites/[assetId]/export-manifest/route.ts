import { proxyEpisodeExport } from "../../../../../../../../../../lib/episode-export-proxy";

export function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; episodeId: string; assetId: string }> },
): Promise<Response> {
  return proxyEpisodeExport(request, context.params, "export-manifest");
}
