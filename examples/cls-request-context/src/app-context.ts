import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "@spinejs/electron-ipc-gateway";
import type { ContextFactory } from "@spinejs/gateway-core";

/**
 * The app's dispatch context: the transport's base context (the electron event) plus the caller's
 * identity, read from the IPC payload. The CLS interceptor seeds the request scope from this.
 */
export interface AppContext extends ElectronIpcBaseContext {
  user: string;
}

/**
 * Register `AppContext` as the app-wide default `ctx` for every route — done ONCE, like augmenting
 * `Express.Request`. After this, the framework-level `handle` imported straight from
 * `@spinejs/electron-ipc-gateway` types its callback's `ctx` as `AppContext` with no per-file
 * factory. Drop this augmentation and `ctx` falls back to `ElectronIpcBaseContext` (no `ctx.user`).
 */
declare module "@spinejs/electron-ipc-gateway" {
  interface IpcContextRegistry {
    context: AppContext;
  }
}

/** Builds one `AppContext` per IPC call, taking `user` from the payload (defaults to anonymous). */
export class AppContextFactory
  implements ContextFactory<ElectronIpcRaw, AppContext>
{
  create(raw: ElectronIpcRaw): AppContext {
    const [payload] = raw.args as [{ user?: string } | undefined];
    return { event: raw.event, user: payload?.user ?? "anonymous" };
  }
}
