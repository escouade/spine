import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import type { ClsService, ClsStore } from "./cls.service";

/**
 * Generic per-dispatch CLS scope opener for any `@spinejs/gateway-core` transport. Default `seed` spreads
 * the whole dispatch context into the store, so a plain `interface AppContext extends ...` is enough
 * to use CLS — no app has to hand-write this class. Pass a custom `seed` when the store needs
 * something the context doesn't carry verbatim (e.g. a generated `reqId`).
 */
export class ClsInterceptor<Ctx extends GatewayContext>
  implements GatewayInterceptor<Ctx>
{
  constructor(
    private readonly cls: ClsService,
    private readonly seed: (ctx: Ctx) => ClsStore = (ctx) =>
      ({ ...ctx } as ClsStore)
  ) {}

  intercept(
    _target: DispatchTarget<Ctx>,
    ctx: Ctx,
    _rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    return this.cls.run(this.seed(ctx), next);
  }
}
