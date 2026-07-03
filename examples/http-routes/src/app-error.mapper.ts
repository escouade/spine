import type { ErrorMapper } from "@spinejs/gateway-core";
import { ValidationError, UnauthorizedError } from "@spinejs/gateway-core";
import { NotFoundError } from "./not-found.error";

export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

/** App `ErrorMapper`: same as `DefaultHttpErrorMapper` plus a `NOT_FOUND` code for `NotFoundError`. */
export class AppErrorMapper implements ErrorMapper<AppErrorCode> {
  toCode(err: unknown): AppErrorCode {
    if (err instanceof NotFoundError) return "NOT_FOUND";
    if (err instanceof ValidationError) return "BAD_REQUEST";
    if (err instanceof UnauthorizedError) return "UNAUTHORIZED";
    return "INTERNAL_ERROR";
  }
}

const statusByCode: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

export function appStatusMapper(code: string): number {
  return statusByCode[code as AppErrorCode] ?? 500;
}
