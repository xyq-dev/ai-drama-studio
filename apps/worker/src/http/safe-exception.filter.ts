import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { SERVICE_NAME } from "@ai-drama/contracts";

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const name = exception instanceof Error ? exception.name : "Error";
    this.logger.error(`request failed: ${name}`);
    response.status(status).json({
      service: SERVICE_NAME.worker,
      status: "degraded",
      message: "request failed",
    });
  }
}
