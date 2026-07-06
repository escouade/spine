/**
 * Fail-closed production detection (AD-8, NFR-2). Destructive or automatic migration operations
 * (`migration:fresh`, `migrateOnStart`) run **only** when `NODE_ENV` is explicitly `development` or
 * `test`. Every other value — `production`, an unrecognized label, or unset — refuses: the environment
 * must *prove* it is non-production, never merely fail to prove it is production. `NODE_ENV` labels the
 * environment, not the database — it is defense-in-depth, not the only guard (see `--force-drop`).
 *
 * `nodeEnv` is a parameter (defaulting to `process.env.NODE_ENV`) purely so the rule is unit-testable
 * without mutating the process environment.
 */
export function isDevelopmentOrTest(
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}
