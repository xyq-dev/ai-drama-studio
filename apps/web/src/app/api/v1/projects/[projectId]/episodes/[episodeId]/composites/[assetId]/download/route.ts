import { proxyEpisodeExport } from "../../../../../../../../../../lib/episode-export-proxy";

type ExportContext = { params: Promise<{ projectId: string; episodeId: string; assetId: string }> };

export function GET(request: Request, context: ExportContext): Promise<Response> {
  return proxyEpisodeExport(request, context.params, "download");
}

export function HEAD(request: Request, context: ExportContext): Promise<Response> {
  return proxyEpisodeExport(request, context.params, "download");
}
