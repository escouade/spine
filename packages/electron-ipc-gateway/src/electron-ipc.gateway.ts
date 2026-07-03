import { ipcMain } from "electron";
import { Logger } from "@spinejs/core";
import {
  ContextFactory,
  DispatchPipeline,
  ErrorMapper,
  GatewayInterceptor,
  LoadedRoute,
  Validator,
} from "@spinejs/gateway-core";
import {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "./electron-ipc-base.types";

/** A route the IPC transport mounts: the shared dispatch target plus the string channel address. */
export type IpcRoute<
  Ctx extends ElectronIpcBaseContext = ElectronIpcBaseContext
> = LoadedRoute<Ctx, string>;

/**
 * Generic electron IPC transport binding. App-agnostic: it knows only `ipcMain` and the electron
 * event — the context (session, user…) is built by an injected `ContextFactory`, so nothing
 * app-specific (SessionStore, UserProfile) leaks in. **Composes** `DispatchPipeline` (guards →
 * validate → invoke → envelope) rather than extending a base; the transport owns `register`/`bind`.
 * Constructed via a factory provider (no `@Injectable`) so the class stays free of DI-token identity.
 */
export class ElectronIpcGateway<
  Ctx extends ElectronIpcBaseContext = ElectronIpcBaseContext,
  Code extends string = string
> {
  private readonly pipeline: DispatchPipeline<Ctx, Code, IpcRoute<Ctx>>;

  constructor(
    validator: Validator,
    errorMapper: ErrorMapper<Code>,
    private readonly contextFactory: ContextFactory<ElectronIpcRaw, Ctx>,
    private readonly logger: Logger,
    interceptors: GatewayInterceptor<Ctx, Code, IpcRoute<Ctx>>[] = []
  ) {
    this.pipeline = new DispatchPipeline<Ctx, Code, IpcRoute<Ctx>>(
      validator,
      errorMapper,
      interceptors
    );
  }

  /** Mounts pre-resolved IPC routes on `ipcMain`. Called by the feature module. */
  register(routes: IpcRoute<Ctx>[]): void {
    for (const route of routes) this.bind(route);
  }

  private bind(route: IpcRoute<Ctx>): void {
    this.logger.debug(
      `Register IPC route ${route.address}.`,
      ElectronIpcGateway.name
    );

    ipcMain.handle(route.address, async (event, ...args) => {
      const ctx = this.contextFactory.create({ event, args });
      const rawInput = args.length > 1 ? args : args[0];
      const envelope = await this.pipeline.dispatch(route, ctx, rawInput);
      if (!envelope.ok) {
        this.logger.debug(
          `IPC route ${route.address} failed: ${envelope.code}`,
          ElectronIpcGateway.name
        );
      }
      return envelope;
    });
  }
}
