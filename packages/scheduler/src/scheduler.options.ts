import type { ModuleEntry, Token } from "@spinejs/core";
import type { ClsStore } from "@spinejs/cls";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A tick's work. Receives the instances resolved from `inject`, positionally.
 *
 * `any[]` (not `unknown[]`) so a concrete `run: (p: Projector) => …` stays assignable — argument
 * contravariance, the same reason `@spinejs/core` types provider factories with `any[]`.
 */
export type TickRun = (...deps: any[]) => unknown | Promise<unknown>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Wraps a tick's run, INSIDE the CLS scope. Compose a per-tick UnitOfWork, tracing, metrics…
 * `@spinejs/mikro-orm` supplies one that forks an EntityManager into CLS — making a tick a
 * request-scoped UnitOfWork, exactly like an HTTP request.
 */
export type TickAround = (next: () => Promise<void>) => () => Promise<void>;

export interface ScheduledTask {
  /** Unique task name (used for logging and duplicate detection). */
  name: string;
  /** Fixed delay between ticks, in milliseconds. */
  everyMs: number;
  /**
   * Tokens resolved by DI and passed to `run`, in order. The modules that export these tokens must
   * be listed in {@link SchedulerOptions.imports} so the scheduler can resolve them.
   */
  inject?: Token[];
  /** The work to run each tick. Receives the resolved `inject` instances. */
  run: TickRun;
  /**
   * What to do when the previous tick is still running:
   * - `skip` (default): drop this tick (a poll loop never piles up).
   * - `queue`: serialize — run after the in-flight tick (and any already queued) settles.
   */
  overlap?: "skip" | "queue";
  /** Seed for this tick's fresh CLS scope. Defaults to `{}`. */
  seed?: () => ClsStore;
  /** Wrappers applied inside the CLS scope, outermost first (e.g. a per-tick UnitOfWork). */
  around?: TickAround[];
}

export interface SchedulerOptions {
  /** Modules that export the tokens used in tasks' `inject`. Merged with `ClsModule`. */
  imports?: ModuleEntry[];
  /** The periodic tasks to register. */
  tasks: ScheduledTask[];
}
