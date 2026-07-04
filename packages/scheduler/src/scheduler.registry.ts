import type { ClsService, ClsStore } from "@spinejs/cls";
import type { Logger } from "@spinejs/core";
import type { ScheduledTask, TickAround } from "./scheduler.options";

interface TaskState {
  readonly task: ScheduledTask;
  /** `run(...deps)` wrapped by the `around` chain — everything except the CLS scope. */
  readonly boundRun: () => Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
  /** Resolves when the current (and, for `queue`, any trailing) tick settles. */
  inflight: Promise<void>;
}

/** Compose `around` hooks around the bound run, outermost first. */
const compose = (
  arounds: readonly TickAround[],
  run: () => Promise<void>
): (() => Promise<void>) =>
  arounds.reduceRight<() => Promise<void>>((next, around) => around(next), run);

/**
 * Runtime for scheduled tasks: arms one interval timer per task, runs each tick inside a fresh CLS
 * scope, enforces the overlap policy, and drains in-flight ticks on stop. Transport-agnostic and
 * DI-free — the module wires dependencies; this class is directly unit-testable.
 */
export class SchedulerRegistry {
  private readonly states = new Map<string, TaskState>();

  constructor(private readonly cls: ClsService, private readonly log: Logger) {}

  /** Register a task with its already-resolved dependency instances (positional, matching `task.inject`). */
  register(task: ScheduledTask, deps: readonly unknown[]): void {
    if (this.states.has(task.name)) {
      throw new Error(`Scheduler: duplicate task name "${task.name}"`);
    }
    const run = async (): Promise<void> => {
      await task.run(...deps);
    };
    this.states.set(task.name, {
      task,
      boundRun: compose(task.around ?? [], run),
      running: false,
      inflight: Promise.resolve(),
    });
  }

  /** Arm every task's interval timer. Idempotent. Call from a module's `onStart`. */
  start(): void {
    for (const s of this.states.values()) {
      if (s.timer) continue;
      s.timer = setInterval(
        () => void this.runNow(s.task.name),
        s.task.everyMs
      );
      // A scheduler timer must never, on its own, keep the process alive.
      s.timer.unref?.();
    }
  }

  /**
   * Run one tick of a task now (also the timer callback). Honors the overlap policy. Resolves when
   * this invocation's work settles (immediately if skipped). Never rejects — a failing tick is
   * caught and logged so one bad tick can't crash the app or kill the timer.
   */
  runNow(name: string): Promise<void> {
    const s = this.states.get(name);
    if (!s) return Promise.resolve();
    const overlap = s.task.overlap ?? "skip";
    if (overlap === "queue") {
      const next = s.inflight.then(
        () => this.runOnce(s),
        () => this.runOnce(s)
      );
      s.inflight = next;
      return next;
    }
    if (s.running) return Promise.resolve(); // skip
    s.inflight = this.runOnce(s);
    return s.inflight;
  }

  private async runOnce(s: TaskState): Promise<void> {
    s.running = true;
    const seed: ClsStore = s.task.seed?.() ?? {};
    try {
      // Each tick is its own CLS scope: a synthetic request. `around` hooks (e.g. a UnitOfWork)
      // run inside it, so services resolve request-scoped state with no manager threading.
      await this.cls.run(seed, s.boundRun);
    } catch (e) {
      this.log.error(`scheduler task "${s.task.name}" failed`, e);
    } finally {
      s.running = false;
    }
  }

  /** Stop all timers and wait for in-flight (and queued) ticks to settle. Call from `onStop`. */
  async stop(): Promise<void> {
    for (const s of this.states.values()) {
      if (s.timer) clearInterval(s.timer);
      s.timer = undefined;
    }
    await Promise.allSettled([...this.states.values()].map((s) => s.inflight));
  }

  /** True while a named task's tick is executing (introspection / tests). */
  isRunning(name: string): boolean {
    return this.states.get(name)?.running ?? false;
  }

  /** Registered task names (introspection / tests). */
  get taskNames(): string[] {
    return [...this.states.keys()];
  }
}
