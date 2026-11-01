import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { SERVICE_NAME } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    // Express/body-parser throws before a controller runs. Recognize only its bounded JSON-body refusal; never
    // serialize its message/body fields, which can contain the submitted private text.
    if (exception && typeof exception === "object" && "type" in exception && "status" in exception
      && exception.type === "entity.too.large" && exception.status === HttpStatus.PAYLOAD_TOO_LARGE) {
      response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
        error: { code: "REQUEST_BODY_TOO_LARGE", message: "请求内容超过大小上限。", traceId: "api" },
      });
      return;
    }
    if (exception instanceof PersistenceError) {
      this.logger.error(`request failed: ${exception.code}`);
      response.status(httpStatus(exception.code)).json({
        error: {
          code: exception.code,
          message: exception.message,
          traceId: "api",
          ...(exception.details ? { details: exception.details } : {}),
        },
      });
      return;
    }
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const name = exception instanceof Error ? exception.name : "Error";
    this.logger.error(`request failed: ${name}`);
    response.status(status).json({
      service: SERVICE_NAME.api,
      status: "degraded",
      message: "request failed",
    });
  }
}

function httpStatus(code: string): number {
  if (["REAL_MEDIA_NOT_READY", "REAL_MEDIA_STORAGE_NOT_READY", "REAL_MEDIA_RECEIPT_KEY_MISSING",
    "REAL_MEDIA_RECEIPT_UNAVAILABLE", "SPEECH_STORAGE_UNAVAILABLE", "SPEECH_STORAGE_CORRUPT",
    "REAL_MEDIA_TOOLS_UNAVAILABLE", "REAL_MEDIA_PROVIDER_DISABLED"].includes(code)) return 503;
  if (["REAL_MEDIA_INPUT_CHANGED", "REAL_MEDIA_CONFIGURATION_CHANGED", "REAL_MEDIA_AUTHORIZATION_INVALID",
    "REAL_MEDIA_AUTHORIZATION_USED", "REAL_MEDIA_QUOTE_EXPIRED", "REAL_MEDIA_UNCERTAIN_CHANGED", "SPEECH_PLAN_STALE", "SPEECH_SELECTION_STALE"].includes(code)) return 409;
  if (["SPEECH_AUDIO_OVERFLOW", "REAL_MEDIA_BUDGET_MISMATCH"].includes(code)) return 422;
  if (code === "NOT_FOUND" || code === "JOB_NOT_FOUND" || code === "WORKFLOW_NOT_FOUND") return 404;
  if (
    code === "IDEMPOTENCY_KEY_REUSED" ||
    code === "IDEMPOTENCY_IN_PROGRESS" ||
    code === "REVISION_CONFLICT" ||
    code === "REVIEW_INVALID_TRANSITION" ||
    code === "REVIEW_CONFLICT" ||
    code === "EVENT_CURSOR_EXPIRED" ||
    code === "JOB_TERMINAL" ||
    code === "RUN_TERMINAL" ||
    code === "JOB_NOT_RETRYABLE" ||
    code === "RETRY_LIMIT" ||
    code === "RETRY_LINEAGE_INVALID" ||
    code === "REFERENCE_SELECTION_CONFLICT" ||
    code === "COMPOSE_INPUT_CHANGED" ||
    code === "COMPOSE_CONTENT_HASH_MISMATCH"
  ) {
    return 409;
  }
  if (code === "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" || code === "ASSET_STORAGE_ERROR" || code === "EPISODE_PLAN_UNAVAILABLE") return 503;
  return 400;
}
