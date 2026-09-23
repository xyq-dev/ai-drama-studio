import { SERVICE_NAME, type AdapterHealthResponse } from "@ai-drama/contracts";

export function isValidHttpUrl(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildAdapterHealth(baseUrl: string | undefined, now = new Date()): AdapterHealthResponse {
  const provided = baseUrl !== undefined && baseUrl.trim().length > 0;
  const comfyuiConfigured = isValidHttpUrl(baseUrl);
  return {
    service: SERVICE_NAME.comfyuiAdapter,
    status: provided && !comfyuiConfigured ? "degraded" : "ok",
    mode: "stub",
    comfyuiConfigured,
    timestamp: now.toISOString(),
  };
}
