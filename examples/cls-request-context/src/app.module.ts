import { randomUUID } from "node:crypto";
import type { ModuleEntry } from "@spinejs/core";
import { ClsInterceptor, ClsModule, ClsService } from "@spinejs/cls";
import {
  ElectronIpcGatewayModule,
  ipcFeature,
} from "@spinejs/electron-ipc-gateway";
import { AppContextFactory } from "./app-context";
import type { AppContext } from "./app-context";
import { AuditService } from "./audit.service";
import { WhoAmIController } from "./whoami.controller";
import { DispatchContext } from "./dispatch-store";

/**
 * Wiring. `ClsModule` is imported in BOTH the transport module (for the interceptor) and the feature
 * module (for the typed `DispatchContext`). Because `ClsModule` is a single (non-`fresh`) module, both
 * imports share the same `ClsService` instance — the interceptor's `run()` and `DispatchContext`'s
 * `get()` use the same `AsyncLocalStorage`, which is essential.
 *
 * No hand-written interceptor class: `@spinejs/cls`'s generic `ClsInterceptor` only needs a `seed`
 * function mapping the dispatch context to the store (here adding a generated `reqId`). No factory
 * for the typed context either: `DispatchContext` is aliased to the same `ClsService` singleton via
 * `existing` — same object, just re-typed against `DispatchStore`.
 */
export const modules: ModuleEntry[] = [
  ElectronIpcGatewayModule.configure({
    imports: [ClsModule],
    contextFactory: { value: new AppContextFactory() },
    interceptors: {
      inject: [ClsService],
      factory: (cls: ClsService) => [
        new ClsInterceptor<AppContext>(cls, (ctx) => ({
          user: ctx.user,
          reqId: randomUUID(),
        })),
      ],
    },
  }),
  ipcFeature({
    controllers: [WhoAmIController],
    providers: [
      AuditService,
      { provide: DispatchContext, existing: ClsService },
    ],
    imports: [ClsModule],
  }),
];
