import { Timer } from "./utils";
import { Logger } from "./logger/logger.interface";
import { AppOptions } from "./types";
import { AppLogger } from "./logger";
import { Container, InjectionToken } from "./container";
import { ModuleEntry, ModuleLoader, hasOnStart, hasOnStop } from "./module";

export const appToken = new InjectionToken<App>("global.app");
export const loggerToken = new InjectionToken<Logger>("global.logger");
/**
 * Application root class.
 * Orchestrates logger, DI container and module loader,
 * and manages the process lifecycle (signals, exceptions, clean exit).
 */
export class App {
  private readonly loader: ModuleLoader;
  private readonly globalContainer: Container;
  private readonly timer = new Timer();

  private exiting = false;
  private started = false;
  private stopped = false;
  private hasExitLogger = false;
  private readonly shutdownTimeout: number;

  // Stable handler refs: stored so process.removeListener() can detach them on stop().
  // Inline closures would be anonymous and impossible to remove → leaked across App instances.
  private readonly onUncaughtException = (error: unknown) =>
    this.uncaughtExceptionHandler(error);
  private readonly onUnhandledRejection = (reason: unknown) =>
    this.uncaughtRejectionHandler(reason);
  private readonly onSignalExit = () => this.exitHandler();

  public readonly logger: Logger;

  constructor(modules: ModuleEntry[], options?: AppOptions) {
    this.timer.start("boot");

    if (options?.logger) {
      this.logger = options.logger;
    } else {
      this.logger = new AppLogger(options?.loggerOptions ?? {});
    }

    this.logger.info("⏳ Application initialization...", App.name);

    this.shutdownTimeout = options?.shutdownTimeout ?? 5_000;

    this.handleProcessErrors();

    if (options?.handleProcessExit !== false) {
      // watch process for graceful exit
      this.handleProcessExit();
    }

    this.globalContainer = new Container(this.logger, "Container.Global");
    this.globalContainer.addMany([
      { provide: appToken, value: this },
      { provide: loggerToken, value: this.logger },
    ]);

    this.loader = new ModuleLoader(this.logger, this.globalContainer, modules);
  }

  async init() {
    this.timer.start("init");
    try {
      // The loader builds the nodes, detects cycles and runs every onInit() (deps before
      // dependents). Loaded modules live on `this.loader.modules` (read by start()/stop()).
      await this.loader.load();
    } catch (e) {
      // Atomic init: a partial boot leaves nothing running. Stop the modules that DID initialize
      // (reverse order), then rethrow. A module that fails its own onInit() owns its cleanup
      // (it never enters the registry) — onStop() is only guaranteed for successful onInit().
      await this.stop();
      throw e;
    }
    this.logger.debug(
      `App initialized in ${this.timer.getTime("init")} ms`,
      App.name
    );
  }

  public async start(): Promise<void> {
    // Terminal once stopped: modules are not cleared on stop(), so re-running onStart would fire
    // hooks on torn-down instances. Idempotent on a live App (a second start() is a no-op).
    if (this.stopped) throw new Error("Cannot start a stopped App");
    if (this.started) return;
    this.started = true;
    // onStart hooks in init order (deps before dependents), after the whole graph is initialized.
    try {
      for (const ref of this.loader.modules.values()) {
        if (hasOnStart(ref.instance)) await ref.instance.onStart();
      }
    } catch (e) {
      // Atomic start, mirroring init(): a failed onStart() must not leave earlier modules running.
      // stop() runs onStop() for every initialized module — onStop pairs with onInit (not onStart),
      // so it is the correct cleanup whether or not a module's onStart() had already run.
      await this.stop();
      throw e;
    }
    // 'boot' started in the constructor → full startup time.
    this.logger.debug(
      `🚀 App started in ${this.timer.getTime("boot")} ms`,
      App.name
    );
  }

  public async stop(): Promise<void> {
    // Idempotent & terminal: a failed init() self-stops, then the caller's exit()→stop() is a no-op.
    if (this.stopped) return;
    this.stopped = true;

    this.logger.debug("🥱 Application shutdown ...", App.name);

    // onStop hooks in reverse init order (dependents stop before their deps).
    for (const ref of [...this.loader.modules.values()].reverse()) {
      if (hasOnStop(ref.instance)) await ref.instance.onStop();
    }
    // Release the process-level listeners installed at construction: the App is now terminal.
    this.detachProcessHandlers();

    this.logger.info("😴 Application stopped", App.name);
  }

  /** Clean exit: stops the app, lets the logger flush, then exits the process. */
  public async exit(code = 0): Promise<void> {
    // Re-entrance guard: the first call owns the shutdown. Without it, a second trigger
    // (duplicate signal, or process.exit() re-firing handlers) would replay stop()/onStop
    // on already-stopped modules.
    if (this.exiting) return;
    this.exiting = true;

    // Hard kill net: whatever hangs in the shutdown sequence (a dangling onStop(), a stuck
    // logger flush) must not keep the process alive forever. This timer force-exits past
    // `shutdownTimeout`; the clean path clears it before its own process.exit().
    // `shutdownTimeout: 0` disables the net and waits indefinitely.
    const hardKill = this.shutdownTimeout
      ? setTimeout(() => {
          this.logger.error(
            `⌛ Graceful shutdown exceeded ${this.shutdownTimeout}ms, forcing exit`,
            App.name
          );
          process.exit(code);
        }, this.shutdownTimeout)
      : undefined;

    try {
      await this.stop();
    } catch (e) {
      this.logger.error(e, App.name);
    }

    if (!this.hasExitLogger) {
      this.hasExitLogger = true;
      await this.logger.exit();
    }

    if (hardKill) clearTimeout(hardKill);

    process.exit(code);
  }

  private exitHandler(): Promise<void> | void {
    return this.exit();
  }

  private uncaughtExceptionHandler(error: unknown): Promise<void> {
    if (!this.hasExitLogger) {
      this.logger.error("💥 App: Uncaught Exception :(");
      this.logger.error(error);
    } else {
      console.error(error);
    }
    return this.exit(1);
  }

  private uncaughtRejectionHandler(error: unknown): Promise<void> {
    if (!this.hasExitLogger) {
      this.logger.error("💥 App: Uncaught Rejection :(");
      this.logger.error(error);
    } else {
      console.error(error);
    }
    return this.exit(1);
  }

  private handleProcessErrors(): void {
    // uncaught exceptions
    process.on("uncaughtException", this.onUncaughtException);
    process.on("unhandledRejection", this.onUnhandledRejection);
  }

  private handleProcessExit(): void {
    // No 'exit' listener: it runs synchronously (event loop already dead), so our async
    // stop()/logger.exit() would be silently skipped. We only watch signals that fire while
    // the process is still alive, leaving room for graceful async shutdown.
    // ctrl+c
    process.on("SIGINT", this.onSignalExit);
    // kill / docker stop / systemd
    process.on("SIGTERM", this.onSignalExit);
  }

  /**
   * Detaches every process-level listener installed by the constructor. Called from stop() (the
   * terminal phase) so a dead App stops reacting to signals/errors and several App instances don't
   * stack listeners (MaxListenersExceededWarning + handlers firing on already-stopped Apps).
   * removeListener for an absent listener is a no-op, so detaching the signal handlers is safe
   * even when handleProcessExit was disabled by option.
   */
  private detachProcessHandlers(): void {
    process.removeListener("uncaughtException", this.onUncaughtException);
    process.removeListener("unhandledRejection", this.onUnhandledRejection);
    process.removeListener("SIGINT", this.onSignalExit);
    process.removeListener("SIGTERM", this.onSignalExit);
  }
}
