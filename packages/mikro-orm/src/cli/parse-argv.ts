/**
 * The migration verbs, in the `migration:<verb>` CLI grammar. `create`/`up`/`down`/`list`/`pending`
 * land in Epic 2; `fresh` in Epic 3 — parsed here from the start so the grammar is defined in one
 * place and `fresh` needs no parser change later.
 */
export const MIGRATION_COMMANDS = [
  "create",
  "up",
  "down",
  "list",
  "pending",
  "fresh",
] as const;

export type MigrationCommand = (typeof MIGRATION_COMMANDS)[number];

/**
 * Parsed CLI flags. `to` targets a version (`up`/`down`); `blank`/`initial` are `create` variants;
 * `forceDrop` is the orthogonal second confirmation `fresh` requires (Epic 3). `--connection` is not
 * here — it surfaces as the top-level {@link ParsedMigrationArgv.connection} (it selects the target,
 * it is not a verb option).
 */
export interface MigrationFlags {
  to?: string;
  blank?: boolean;
  initial?: boolean;
  forceDrop?: boolean;
}

/** The typed shape a raw argv line reduces to: which verb, against which connection, with what flags. */
export interface ParsedMigrationArgv {
  command: MigrationCommand;
  /** The `--connection <name>` target, or `undefined` (resolved to the default connection downstream). */
  connection: string | undefined;
  flags: MigrationFlags;
}

// Flags that consume the following token (or an inline `=value`) as their value.
const VALUE_FLAGS = new Set(["--connection", "--to"]);
// Boolean flags — present means true, they take no value.
const BOOLEAN_FLAGS = new Set(["--blank", "--initial", "--force-drop"]);

const verbList = MIGRATION_COMMANDS.join(", ");

const isMigrationCommand = (verb: string): verb is MigrationCommand =>
  (MIGRATION_COMMANDS as readonly string[]).includes(verb);

/**
 * Pure `argv → { command, connection, flags }` parser (AD-10, Story 2.3): depends on nothing but its
 * input — no boot, no DI, no `@mikro-orm/*` — so it is unit-testable in isolation and the high-risk
 * composition-root (Story 2.5) carries no parsing logic.
 *
 * `argv` is the arguments **after** the binary name (e.g. `process.argv.slice(2)`). The first token
 * is the `migration:<verb>` command; the rest are flags. Parsing fails closed with an actionable
 * message on a missing command, an unknown verb, an unknown flag, or a value flag with no value — a
 * typo never silently runs the wrong verb.
 */
export function parseArgv(argv: string[]): ParsedMigrationArgv {
  const [commandToken, ...rest] = argv;
  if (!commandToken) {
    throw new Error(
      `@spinejs/mikro-orm: no migration command given. Expected "migration:<verb>" where <verb> is one of: ${verbList}.`
    );
  }

  const command = parseCommand(commandToken);
  let connection: string | undefined;
  const flags: MigrationFlags = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const eq = token.indexOf("=");
    const key = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    if (VALUE_FLAGS.has(key)) {
      const value = readValue(key, inlineValue, rest, i);
      // Advance past a consumed following token (not needed for the inline `=value` form).
      if (inlineValue === undefined) i++;
      if (key === "--connection") connection = value;
      else flags.to = value;
      continue;
    }

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        throw new Error(
          `@spinejs/mikro-orm: flag "${key}" takes no value (got "${key}=${inlineValue}").`
        );
      }
      if (key === "--blank") flags.blank = true;
      else if (key === "--initial") flags.initial = true;
      else flags.forceDrop = true;
      continue;
    }

    throw new Error(
      `@spinejs/mikro-orm: unknown flag "${key}". Supported flags: --connection, --to, --blank, --initial, --force-drop.`
    );
  }

  return { command, connection, flags };
}

function parseCommand(token: string): MigrationCommand {
  const [namespace, verb] = token.split(":");
  if (namespace !== "migration" || !verb || !isMigrationCommand(verb)) {
    throw new Error(
      `@spinejs/mikro-orm: unknown migration command "${token}". Expected "migration:<verb>" where <verb> is one of: ${verbList}.`
    );
  }
  return verb;
}

function readValue(
  key: string,
  inlineValue: string | undefined,
  rest: string[],
  i: number
): string {
  if (inlineValue !== undefined) {
    if (inlineValue === "") {
      throw new Error(`@spinejs/mikro-orm: flag "${key}" requires a value.`);
    }
    return inlineValue;
  }
  // Consume the following token — but a token that is itself a flag means the value was omitted
  // (`--to --blank`), not that `--blank` is the value.
  const next = rest[i + 1];
  if (next === undefined || next === "" || next.startsWith("--")) {
    throw new Error(`@spinejs/mikro-orm: flag "${key}" requires a value.`);
  }
  return next;
}
