import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { ApiEnv } from "../config/env";
import { API_ENV } from "./tokens";

@Injectable()
export class ObjectStorageHealth implements OnModuleDestroy {
  private readonly client: S3Client;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async check(): Promise<"ok" | "down"> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }), {
        abortSignal: AbortSignal.timeout(this.env.HEALTH_CHECK_TIMEOUT_MS),
      });
      return "ok";
    } catch {
      return "down";
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
