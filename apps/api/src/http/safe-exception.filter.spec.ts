import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SafeExceptionFilter } from "./safe-exception.filter";

function responseFor(exception: unknown) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
  new SafeExceptionFilter().catch(exception, host);
  return { status, json };
}

describe("safe JSON body size refusal", () => {
  it("reports body-parser's entity.too.large as 413 without private submitted text", () => {
    const exception = Object.assign(new Error("private script SECRET-REQUEST-TEXT"), {
      type: "entity.too.large", status: 413, body: "SECRET-REQUEST-TEXT", expected: 400_000,
    });
    const { status, json } = responseFor(exception);
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: {
      code: "REQUEST_BODY_TOO_LARGE", message: "请求内容超过大小上限。", traceId: "api",
    } });
    expect(JSON.stringify(json.mock.calls)).not.toContain("SECRET-REQUEST-TEXT");
  });

  it.each([
    Object.assign(new Error("private"), { status: 413 }),
    Object.assign(new Error("private"), { type: "entity.too.large", status: 400 }),
    Object.assign(new Error("private"), { type: "other", status: 413 }),
    new Error("private"),
  ])("preserves the generic error response for unrelated errors", (exception) => {
    const { status, json } = responseFor(exception);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ service: "api", status: "degraded", message: "request failed" });
  });

  it("preserves other HttpException status and generic response behavior", () => {
    const { status, json } = responseFor(new HttpException("private", 422));
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({ service: "api", status: "degraded", message: "request failed" });
  });
});
