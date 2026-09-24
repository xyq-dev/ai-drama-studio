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
    if (exception instanceof PersistenceError) {
      this.logger.error(`request failed: ${exception.code}`);
      response.status(httpStatus(exception.code)).json({
        error: { code: exception.code, message: exception.message, traceId: "api" },
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
  if (code === "NOT_FOUND" || code === "JOB_NOT_FOUND" || code === "WORKFLOW_NOT_FOUND") return 404;
  if (
    code === "IDEMPOTENCY_KEY_REUSED" ||
    code === "EVENT_CURSOR_EXPIRED" ||
    code === "JOB_TERMINAL" ||
    code === "RUN_TERMINAL" ||
    code === "JOB_NOT_RETRYABLE"
  ) {
    return 409;
  }
  return 400;
}
