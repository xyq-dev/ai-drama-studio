import { Body, Controller, Headers, Inject, Param, Post, Put, Req, Res, type RawBodyRequest } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { createTraceId } from "./studio.service";
import type { AssetUploadService } from "./asset-upload.service";

export const ASSET_UPLOAD_SERVICE = Symbol("ASSET_UPLOAD_SERVICE");

const UUID_PIPE = {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
    }
    return value.toLowerCase();
  },
};

interface StatusResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

@Controller()
export class AssetUploadController {
  constructor(@Inject(ASSET_UPLOAD_SERVICE) private readonly uploads: AssetUploadService) {}

  @Post("assets/uploads")
  async createSession(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.uploads.createSession(body));
  }

  @Put("asset-upload-sessions/:uploadSessionId/object")
  async putObject(
    @Param("uploadSessionId", UUID_PIPE) uploadSessionId: string,
    @Req() request: RawBodyRequest<{ body?: Buffer }>,
    @Headers("content-type") contentType: string | undefined,
    @Headers("x-content-sha256") contentSha256: string | undefined,
    @Headers("content-length") contentLength: string | undefined,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    const body = Buffer.isBuffer(request.body) ? request.body
      : Buffer.isBuffer((request as { rawBody?: Buffer }).rawBody) ? (request as { rawBody: Buffer }).rawBody
        : undefined;
    return this.send(response, this.uploads.putObject(uploadSessionId, body, {
      contentType,
      contentSha256,
      contentLength,
    }));
  }

  @Post("asset-upload-sessions/:uploadSessionId/complete")
  async complete(
    @Param("uploadSessionId", UUID_PIPE) uploadSessionId: string,
    @Headers("x-trace-id") traceHeader: string | undefined,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.uploads.complete(uploadSessionId, createTraceId(traceHeader)));
  }

  private async send(
    response: StatusResponse,
    work: Promise<{ status: number; body: unknown }>,
  ): Promise<unknown> {
    response.setHeader("Cache-Control", "private, no-store");
    const result = await work;
    response.status(result.status);
    return result.body;
  }
}
