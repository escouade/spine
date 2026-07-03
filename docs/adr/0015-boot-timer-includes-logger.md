# ADR 0015 — Boot-time measurement includes logger construction

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`app.ts`)
- **Relation**: none.

## Context

`App` reports a boot duration once `start()` completes (`🚀 App started in {ms} ms`). The natural point to start that timer is debatable: right at the top of the constructor (before anything else runs), or only once module resolution begins (after the logger and container are already set up).

Fix commit `3b7188f fix(core): start the boot timer before constructing the logger` moved the timer's start point earlier — from after logger construction to before it — because the original placement under-reported startup time: any overhead in constructing the logger (transport setup, format configuration) was invisible in the reported boot duration.

## Decision

```ts
constructor(modules: ModuleEntry[], options?: AppOptions) {
  this.timer.start("boot");

  if (options?.logger) {
    this.logger = options.logger;
  } else {
    this.logger = new AppLogger(options?.loggerOptions ?? {});
  }
  ...
}
```

```ts
public async start(): Promise<void> {
  ...
  // 'boot' started in the constructor → full startup time.
  this.logger.debug(`🚀 App started in ${this.timer.getTime("boot")} ms`, App.name);
}
```

`timer.start("boot")` is the very first statement in the constructor — nothing, including logger construction, runs before it. The reported boot time is therefore **end-to-end**: from the moment `new App(...)` is called to the moment `start()` resolves, covering logger setup, container/module-loader construction, module graph resolution (`init()`), and every `onStart()` hook.

**Underlying philosophy**: boot time is a user-visible, operational metric (what shows up in logs, what an operator or a liveness-probe timeout budget cares about), not an internal "time spent resolving the module graph" metric. Excluding logger setup would make the number look better without the process actually starting faster.

## Alternatives considered

### Start the timer after logger construction (original behavior, reverted by `3b7188f`)

Rejected (reverted): under-reports total startup time by excluding logger setup overhead, which can be non-trivial depending on the configured transports/formatting.

### Track logger construction and module resolution as separate, independently reported durations

Not pursued: adds reporting complexity (two numbers instead of one) for a benefit — isolating logger overhead specifically — that hasn't been needed; `this.timer` already supports per-module timing (via `Timer<object>` in the module loader) for finer-grained investigation when actually needed, so a single end-to-end boot number is sufficient for the top-level metric.

## Consequences

- **Positive**: the reported boot time reflects actual end-to-end startup latency, useful for orchestration timeouts (e.g. container/liveness probe budgets) and troubleshooting slow starts.
- **Negative**: the single number conflates logger setup and module resolution — isolating which one is slow requires separate instrumentation (e.g. temporarily comparing `AppLogger` construction time directly), not just reading the boot log line.
