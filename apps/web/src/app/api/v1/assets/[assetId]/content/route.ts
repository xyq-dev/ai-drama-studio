import { proxyAssetContent } from "../../../../../../lib/asset-content-proxy";

export function GET(request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  return proxyAssetContent(request, context.params);
}

export function HEAD(request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  return proxyAssetContent(request, context.params);
}
