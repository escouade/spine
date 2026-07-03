import type { DispatchTarget, Envelope, GatewayContext } from "./gateway.types";
import {
  ErrorMapper,
  GatewayInterceptor,
  UnauthorizedError,
  Validator,
} from "./ports";

/**
 * The shared request pipeline, as a **composable helper** (not a base class to extend). Owns the
 * cross-transport core — guards → validate → invoke → envelope, every error mapped to a stable
 * code — and the interceptor chain. A transport *holds* a pipeline and calls `dispatch()` from its
 * own bind/handler, supplying a `DispatchTarget` (guards + input + invoke). Address extraction,
 * context building and emitting the envelope stay 100% on the transport side.
 *
 * Optional interceptors wrap every `dispatch()` call in registration order (first = outermost).
 */
export class DispatchPipeline<
  Ctx extends GatewayContext,
  Code extends string = string,
  Target extends DispatchTarget<Ctx> = DispatchTarget<Ctx>
> {
  constructor(
    private readonly validator: Validator,
    private readonly errorMapper: ErrorMapper<Code>,
    private readonly interceptors: GatewayInterceptor<Ctx, Code, Target>[] = []
  ) {}

  /**
   * Runs the interceptor chain then the core pipeline for one dispatch. Never throws. The transport
   * binds `Target` to its own route type (e.g. `IpcRoute`/`HttpRoute`), so interceptors receive the
   * address-bearing `LoadedRoute`, not just the address-less `DispatchTarget`.
   */
  dispatch(
    target: Target,
    ctx: Ctx,
    rawInput: unknown
  ): Promise<Envelope<unknown, Code>> {
    const run = () => this.runPipeline(target, ctx, rawInput);
    const chain = this.interceptors.reduceRight(
      (next, interceptor) => () =>
        interceptor.intercept(target, ctx, rawInput, next),
      run
    );
    return chain();
  }

  /** Core pipeline (guards → validate → invoke → envelope). Never throws. */
  private async runPipeline(
    target: DispatchTarget<Ctx>,
    ctx: Ctx,
    rawInput: unknown
  ): Promise<Envelope<unknown, Code>> {
    try {
      for (const guard of target.guards) {
        if (!(await guard.canActivate(ctx))) throw new UnauthorizedError();
      }
      const input = target.input
        ? this.validator.validate(target.input, rawInput)
        : rawInput;
      const data = await target.invoke(ctx, input);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: this.errorMapper.toCode(err) };
    }
  }
}
