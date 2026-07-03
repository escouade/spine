import type { ErrorMapper } from "@spinejs/gateway-core";

export type HttpErrorCode = "BAD_REQUEST" | "UNAUTHORIZED" | "INTERNAL_ERROR";

/**
 * Default `ErrorMapper` for HTTP. Maps gateway errors to stable HTTP-meaningful codes
 * that the `HttpGateway` status mapper converts to HTTP status numbers.
 */
export class DefaultHttpErrorMapper implements ErrorMapper<HttpErrorCode> {
  toCode(err: unknown): HttpErrorCode {
    if (!(err instanceof Error)) return "INTERNAL_ERROR";
    if (err.name === "ValidationError") return "BAD_REQUEST";
    if (err.name === "UnauthorizedError") return "UNAUTHORIZED";
    return "INTERNAL_ERROR";
  }
}
