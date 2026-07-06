import { describe, it, expect } from "vitest";
import { isDevelopmentOrTest } from "./mikro-orm.production-safety";

// Story 3.1/3.2 — fail-closed production detection (AD-8, NFR-2).

describe("isDevelopmentOrTest", () => {
  it("is true only for an explicit development or test NODE_ENV", () => {
    expect(isDevelopmentOrTest("development")).toBe(true);
    expect(isDevelopmentOrTest("test")).toBe(true);
  });

  it("refuses production, unknown, and unset/empty (fail-closed)", () => {
    expect(isDevelopmentOrTest("production")).toBe(false);
    expect(isDevelopmentOrTest("staging")).toBe(false);
    expect(isDevelopmentOrTest("")).toBe(false);
    // Case-sensitive: only the exact lowercase labels unlock.
    expect(isDevelopmentOrTest("Development")).toBe(false);
    expect(isDevelopmentOrTest("TEST")).toBe(false);
    // (An unset NODE_ENV — the no-arg call reading `process.env` — is covered by the "" case above:
    // `isDevelopmentOrTest(undefined)` falls back to the default param, so it is not a distinct branch.)
  });
});
