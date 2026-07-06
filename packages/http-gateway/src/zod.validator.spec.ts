import { describe, expect, it } from "vitest";
import { z as z3 } from "zod";
import { z as z4 } from "zod/v4";
import { ValidationError } from "@spinejs/gateway-core";
import { ZodValidator } from "./zod.validator";

describe("ZodValidator", () => {
  const validator = new ZodValidator();

  it("returns the parsed value on success", () => {
    const schema = z3.object({ name: z3.string() });
    expect(validator.validate(schema, { name: "ada" })).toEqual({
      name: "ada",
    });
  });

  it("normalizes a classic zod v3 error into ValidationError", () => {
    const schema = z3.object({ name: z3.string() });
    expect(() => validator.validate(schema, { name: 42 })).toThrowError(
      ValidationError
    );
    expect(() => validator.validate(schema, { name: 42 })).toThrowError(
      /name:/
    );
  });

  it("normalizes a zod/v4 error into ValidationError", () => {
    const schema = z4.object({ name: z4.string() });
    expect(() => validator.validate(schema, { name: 42 })).toThrowError(
      ValidationError
    );
    expect(() => validator.validate(schema, { name: 42 })).toThrowError(
      /name:/
    );
  });

  it("normalizes a v4 error thrown by a foreign zod copy (trait match)", () => {
    // Simulates a second zod v4 copy in the consumer's tree: not our class,
    // but carrying the `$ZodError` trait that `Symbol.hasInstance` matches.
    const foreignError = Object.assign(new Error("invalid"), {
      _zod: { traits: new Set(["ZodError", "$ZodError"]) },
      issues: [{ path: ["user", "name"], message: "expected string" }],
    });
    const schema = {
      parse: () => {
        throw foreignError;
      },
    };
    expect(() => validator.validate(schema, {})).toThrowError(ValidationError);
    expect(() => validator.validate(schema, {})).toThrowError(
      /user\.name: expected string/
    );
  });

  it("maps a root-level issue path to (root)", () => {
    const schema = z4.string();
    expect(() => validator.validate(schema, 42)).toThrowError(/\(root\):/);
  });

  it("rethrows non-zod errors untouched", () => {
    const boom = new Error("boom");
    const schema = {
      parse: () => {
        throw boom;
      },
    };
    expect(() => validator.validate(schema, {})).toThrowError(boom);
  });
});
