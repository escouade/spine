import type { Logger } from "@spinejs/core";
import {
  DefaultLogger,
  type LogContext,
  type LoggerNamespace,
  type LoggerOptions,
} from "@mikro-orm/core";

/** Log context tag for ORM output routed into the spine logger. */
const CONTEXT = "MikroORM";

// Strip ANSI SGR escape sequences so color codes never leak into the structured spine logger, and
// collapse whitespace (MikroORM pretties messages with newlines/indentation).
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*m/g;
const clean = (message: string): string =>
  message.replace(ANSI, "").replace(/\s+/g, " ").trim();

/**
 * Bridges MikroORM's logger to the spine logger — one sink (ADR 0016 §5). It fixes two failure modes of
 * a naive `logger: (msg) => log.debug(msg)` writer:
 *
 * 1. **Severity is preserved.** MikroORM funnels every level through one writer; this maps it back —
 *    `error → log.error`, `warn → log.warn`, everything else `→ log.debug` — so ORM errors/warnings are
 *    not buried at DEBUG. Errors and warnings surface **regardless of `debug`**; query/info/discovery
 *    output stays gated by MikroORM's debug namespaces (`isEnabled`, inherited from `DefaultLogger`).
 * 2. **No ANSI leaks.** Color escape codes are stripped before forwarding.
 *
 * A user-supplied `logger`/`loggerFactory` bypasses this entirely; with no spine logger it is not
 * installed at all (a no-op default), so it never throws.
 */
export class SpineMikroLogger extends DefaultLogger {
  constructor(options: LoggerOptions, private readonly spine: Logger) {
    super(options);
  }

  private forward(
    level: "error" | "warn" | "debug",
    namespace: string,
    message: string
  ): void {
    this.spine[level](`[${namespace}] ${clean(message)}`, CONTEXT);
  }

  override log(
    namespace: LoggerNamespace,
    message: string,
    context?: LogContext
  ): void {
    const level =
      context?.level === "error"
        ? "error"
        : context?.level === "warning"
        ? "warn"
        : "debug";
    // Errors and warnings surface regardless of `debug`; only debug-level (query/info/discovery)
    // output respects MikroORM's namespace/debug gate. Gating first would drop a level-tagged
    // warning/error routed through `log()` when debug is off — contradicting this class's contract.
    if (level === "debug" && !this.isEnabled(namespace, context)) return;
    this.forward(level, namespace, message);
  }

  override error(
    namespace: LoggerNamespace,
    message: string,
    _context?: LogContext
  ): void {
    this.forward("error", namespace, message); // surfaced even without `debug`
  }

  override warn(
    namespace: LoggerNamespace,
    message: string,
    _context?: LogContext
  ): void {
    this.forward("warn", namespace, message); // surfaced even without `debug`
  }
}
