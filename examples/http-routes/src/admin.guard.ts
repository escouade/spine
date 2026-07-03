import { Injectable } from "@spinejs/core";
import type { Guard } from "@spinejs/gateway-core";
import type { AppContext } from "./app-context";

/**
 * Per-route guard: only requests carrying `x-admin: true` may proceed. A `@Controller`'s field
 * routes pass it via the helper options (`guards: [AdminGuard]`); the feature module resolves it
 * from its own container at registration. A rejecting guard makes the pipeline throw
 * `UnauthorizedError` → mapped to `UNAUTHORIZED` → HTTP 401.
 */
@Injectable()
export class AdminGuard implements Guard<AppContext> {
  canActivate(ctx: AppContext): boolean {
    return ctx.honoCtx.req.header("x-admin") === "true";
  }
}
