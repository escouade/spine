import { Logger } from "@spinejs/core";
import type { Envelope } from "@spinejs/gateway-core";
import { GatewayInterceptor } from "@spinejs/gateway-core";
import type { ElectronIpcBaseContext } from "./electron-ipc-base.types";
import type { IpcRoute } from "./electron-ipc.gateway";

/**
 * Transforms the raw IPC input before it is serialised into the debug log.
 * Return a masked copy for sensitive channels (e.g. credentials) or the input
 * unchanged. Called with the channel address so redaction can be per-channel.
 */
export type IpcLogRedactor = (channel: string, input: unknown) => unknown;

/**
 * Logs every IPC dispatch at debug level: channel + serialised input on the way in,
 * channel + ok/error-code on the way out. Wire via `ElectronIpcGatewayModule.configure()`.
 *
 * Pass a `redact` callback to keep secrets (passwords, tokens…) out of the logs:
 * the framework stays policy-free, the app decides which channels/inputs to mask.
 *
 * Transport-specific: narrows the interceptor `Target` to `IpcRoute` so `route.address`
 * (the string channel) is available — a plain `DispatchTarget` carries no address.
 */
export class IpcLoggingInterceptor
  implements GatewayInterceptor<ElectronIpcBaseContext, string, IpcRoute>
{
  constructor(
    private readonly logger: Logger,
    private readonly redact?: IpcLogRedactor
  ) {}

  async intercept(
    route: IpcRoute,
    _ctx: ElectronIpcBaseContext,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    const loggedInput = this.redact
      ? this.redact(route.address, rawInput)
      : rawInput;
    this.logger.debug(
      `→ ${route.address} ${JSON.stringify(loggedInput)}`,
      IpcLoggingInterceptor.name
    );
    const envelope = await next();
    const detail = envelope.ok ? "ok" : `error:${envelope.code}`;
    this.logger.debug(
      `← ${route.address} ${detail}`,
      IpcLoggingInterceptor.name
    );
    return envelope;
  }
}
