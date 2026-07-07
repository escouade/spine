import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
  GatewayInterceptor,
  RequestScoped,
} from "@spinejs/gateway-core";
import type { ClsService, ClsStore } from "./cls.service";

/**
 * Generic per-dispatch CLS scope opener for any `@spinejs/gateway-core` transport. Default `seed` spreads
 * the whole dispatch context into the store, so a plain `interface AppContext extends ...` is enough
 * to use CLS — no app has to hand-write this class. Pass a custom `seed` when the store needs
 * something the context doesn't carry verbatim (e.g. a generated `reqId`).
 */
export class ClsInterceptor<Ctx extends GatewayContext>
  implements GatewayInterceptor<Ctx>, RequestScoped
{
  /**
   * The canonical request-scoped interceptor: it opens a per-dispatch CLS scope (`cls.run`) that every
   * downstream request-scoped resource (a MikroORM fork) lives inside. It must never run at a transport's
   * connection phase — declaring the marker makes the connect-safety boot-assert (ADR 0024) refuse boot
   * if a subclass (or a future edit) ever gave it `interceptConnect`. Today it has none, so it is already
   * excluded from any connect chain by construction (ADR 0022); the marker locks that invariant in.
   */
  readonly requestScoped = true;

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
