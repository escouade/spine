import type { ErrorMapper } from "@spinejs/gateway-core";

/**
 * Default `ErrorMapper`: maps any thrown error to its class name as a stable code (e.g.
 * `ValidationError`, `UnauthorizedError`), `"UNKNOWN"` for non-`Error` throws. Used when an app
 * doesn't supply its own `errorMapper` to `ElectronIpcGatewayModule.configure()`.
 */
export class DefaultErrorMapper implements ErrorMapper<string> {
  toCode(err: unknown): string {
    return err instanceof Error ? err.name : "UNKNOWN";
  }
}
