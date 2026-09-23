import { Inject, Injectable } from "@nestjs/common";
import type { AdapterHealthResponse } from "@ai-drama/contracts";
import type { AdapterEnv } from "../config/env";
import { buildAdapterHealth } from "./adapter-health";
import { ADAPTER_ENV } from "./tokens";

@Injectable()
export class HealthService {
  constructor(@Inject(ADAPTER_ENV) private readonly env: AdapterEnv) {}

  snapshot(): AdapterHealthResponse {
    return buildAdapterHealth(this.env.COMFYUI_BASE_URL);
  }
}
