import { ClsService } from "@spinejs/cls";

/** Per-request store shape: what the `ClsInterceptor` seeds, and what `DispatchContext` reads. */
export interface DispatchStore {
  user: string;
  reqId: string;
}

/**
 * Empty subclass: purely a typed DI token + injection type. Never instantiated directly — provided
 * via `{ provide: DispatchContext, existing: ClsService }`, so the actual object at runtime IS the
 * shared `ClsService` singleton, just re-typed against `DispatchStore`.
 */
export class DispatchContext extends ClsService<DispatchStore> {}
