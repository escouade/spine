import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "@spinejs/electron-ipc-gateway";
import type { ContextFactory } from "@spinejs/gateway-core";

/**
 * This example is about persistence, so the dispatch context is just the transport's base context
 * (the electron event). A real app would enrich it (the authenticated user, a request id, …) — see
 * the `cls-request-context` example for that.
 */
export class AppContextFactory
  implements ContextFactory<ElectronIpcRaw, ElectronIpcBaseContext>
{
  create(raw: ElectronIpcRaw): ElectronIpcBaseContext {
    return { event: raw.event };
  }
}
