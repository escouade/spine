import type { IpcMainInvokeEvent } from "electron";
import type { GatewayContext } from "@spinejs/gateway-core";

/**
 * Transport-level context — app-agnostic. The generic `ElectronIpcGateway` only knows the electron
 * event; any app concern (session, user) is added by an app-provided `ContextFactory`.
 */
export interface ElectronIpcBaseContext extends GatewayContext {
  event: IpcMainInvokeEvent;
}

/** Raw call data handed to the `ContextFactory`: the electron event plus the invoke args. */
export interface ElectronIpcRaw {
  event: IpcMainInvokeEvent;
  args: unknown[];
}
