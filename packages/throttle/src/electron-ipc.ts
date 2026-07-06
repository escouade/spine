// @spinejs/throttle/electron-ipc — the electron IPC preset (AD-1): the `'sender'` key source.
// Optional peer: `@spinejs/electron-ipc-gateway` (type-only import — no runtime `electron` load).
import type { ElectronIpcBaseContext } from "@spinejs/electron-ipc-gateway";
import type { GatewayContext } from "@spinejs/gateway-core";
import type { ThrottleRouteMeta, ThrottleRouteOption } from "./engine";
import type { KeySelector } from "./throttle.types";

/**
 * Route-option typing for electron IPC apps (AD-3): importing anything from
 * `@spinejs/throttle/electron-ipc` makes `throttle` a fully-typed option of the `handle()` helper —
 * full parity with the HTTP verb helpers. Without the battery, writing `throttle:` in `handle()`
 * options is a TS error (unknown property) — the transport carries no battery vocabulary.
 */
declare module "@spinejs/electron-ipc-gateway" {
  // The type parameter must repeat the target interface's list verbatim for declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface IpcRouteSchemas<I> {
    /**
     * Rate-limit policy for this channel: inline `policies` (scoped `routeId#index`,
     * non-overridable), `skip` named gateway defaults, `override` them per-channel — or `false` to
     * opt out of every default. Enforced by `@spinejs/throttle`'s interceptor.
     */
    throttle?: ThrottleRouteOption | false;
  }

  interface IpcRouteMeta {
    /** The stamped `meta.throttle` copy (user fields verbatim + `routeId` = the channel) — see AD-3. */
    throttle?: ThrottleRouteMeta;
  }
}

/**
 * The `'sender'` key source (FR-5): keys an IPC call by the renderer that sent it
 * (`event.sender.id`, the WebContents id) — the IPC analogue of `'ip'`, and deliberately named
 * `'sender'` (an IPC transport has no address; `keyBy: 'ip'` on IPC is a boot error).
 *
 * A call without a sender throws, following the policy's failure policy (fail-closed default).
 *
 *   ThrottleModule.configure({
 *     policies: { perWindow: { limit: 20, windowMs: 1000, keyBy: "sender" } },
 *     keySources: { sender: senderKeySource() },
 *   })
 */
export function senderKeySource(): KeySelector {
  return (ctx: GatewayContext): string => {
    const event = (ctx as ElectronIpcBaseContext).event;
    const id = event?.sender?.id;
    if (typeof id !== "number") {
      throw new Error(
        "senderKeySource: ctx.event.sender is missing — the 'sender' source only works on the electron IPC transport."
      );
    }
    return `sender:${id}`;
  };
}
