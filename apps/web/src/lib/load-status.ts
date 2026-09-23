import { parseReadyHealthResponse } from "@ai-drama/contracts";

export type DisplayStatus = "ok" | "degraded" | "unavailable" | "down" | "unknown";

export interface StatusView {
  environment: string;
  webStatus: "ok";
  apiStatus: "ok" | "degraded" | "unavailable";
  postgres: "ok" | "down" | "unknown";
  redis: "ok" | "down" | "unknown";
  objectStorage: "ok" | "down" | "unknown";
  checkedAt: string;
}

export function isHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function unavailableView(environment: string, checkedAt: string): StatusView {
  return {
    environment,
    webStatus: "ok",
    apiStatus: "unavailable",
    postgres: "unknown",
    redis: "unknown",
    objectStorage: "unknown",
    checkedAt,
  };
}

export function viewFromReady(input: {
  httpStatus: number;
  body: unknown;
  environment: string;
  checkedAt: string;
}): StatusView {
  const parsed = parseReadyHealthResponse(input.body);
  if (!parsed) {
    return unavailableView(input.environment, input.checkedAt);
  }
  const apiStatus = input.httpStatus === 200 && parsed.status === "ok" ? "ok" : "degraded";
  return {
    environment: input.environment,
    webStatus: "ok",
    apiStatus,
    postgres: parsed.dependencies.postgres?.status ?? "unknown",
    redis: parsed.dependencies.redis?.status ?? "unknown",
    objectStorage: parsed.dependencies.objectStorage?.status ?? "unknown",
    checkedAt: input.checkedAt,
  };
}

export async function loadStatusView(options: {
  baseUrl: string;
  environment: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<StatusView> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!isHttpBaseUrl(baseUrl)) {
    return unavailableView(options.environment, checkedAt);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/health/ready`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    return viewFromReady({
      httpStatus: response.status,
      body,
      environment: options.environment,
      checkedAt,
    });
  } catch {
    return unavailableView(options.environment, checkedAt);
  }
}
