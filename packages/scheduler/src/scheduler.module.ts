import {
  loggerToken,
  Module,
  type DynamicModule,
  type FactoryProvider,
  type Logger,
  type OnStart,
  type OnStop,
} from "@spinejs/core";
import { ClsModule, ClsService } from "@spinejs/cls";
import type { SchedulerOptions } from "./scheduler.options";
import { SchedulerRegistry } from "./scheduler.registry";

/**
 * Registers periodic tasks. Each tick runs in its own CLS scope — a *synthetic request* — so a
 * task's services resolve request-scoped state (e.g. a per-tick MikroORM UnitOfWork via an `around`
 * hook) exactly like an HTTP handler, with no manager threading.
 *
 * ```ts
 * SchedulerModule.configure({
 *   imports: [JobsModule],                 // exports Projector, Leases
 *   tasks: [
 *     { name: "outbox-projector", everyMs: 2_000, inject: [Projector],
 *       run: (p: Projector) => p.pollAndCreateJobs(), around: [mikroOrmUnitOfWork] },
 *   ],
 * })
 * ```
 *
 * `mikroOrmUnitOfWork` ships with the separate `@spinejs/mikro-orm` battery; the scheduler has no ORM
 * dependency — any `around` hook composes the same way.
 */
@Module({ inject: [SchedulerRegistry] })
export class SchedulerModule implements OnStart, OnStop {
  constructor(private readonly registry: SchedulerRegistry) {}

  static configure(options: SchedulerOptions): DynamicModule {
    const { tasks, imports = [] } = options;
    const perTaskTokens = tasks.map((t) => t.inject ?? []);
    const flatTokens = perTaskTokens.flat();

    // One factory resolves ClsService + Logger + every task's deps (flattened), then slices the
    // resolved instances back per task. Pure explicit-inject DI — no container introspection. The
    // modules exporting task deps come in via `imports`.
    const registryProvider: FactoryProvider<SchedulerRegistry> = {
      provide: SchedulerRegistry,
      inject: [ClsService, loggerToken, ...flatTokens],
      factory: (cls: ClsService, log: Logger, ...deps: unknown[]) => {
        const registry = new SchedulerRegistry(cls, log);
        let offset = 0;
        tasks.forEach((task, i) => {
          const count = perTaskTokens[i].length;
          registry.register(task, deps.slice(offset, offset + count));
          offset += count;
        });
        return registry;
      },
    };

    return {
      module: SchedulerModule,
      imports: [ClsModule, ...imports],
      providers: [registryProvider],
    };
  }

  onStart(): void {
    this.registry.start();
  }

  onStop(): Promise<void> {
    return this.registry.stop();
  }
}
