import { Inject, Injectable } from "@nestjs/common";
import { QUEUE_STATUS } from "./tokens";

export interface QueueStatus {
  running: boolean;
}

@Injectable()
export class QueueHealth {
  constructor(@Inject(QUEUE_STATUS) private readonly status: QueueStatus) {}

  check(): Promise<"ok" | "down"> {
    return Promise.resolve(this.status.running ? "ok" : "down");
  }
}
