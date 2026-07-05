import { describe, it, expect } from "vitest";
import { parseArgv } from "./parse-argv";

// Story 2.3 — pure argv parser. No boot, no DI, no @mikro-orm/*; unit-tested in isolation (AD-10).

describe("parseArgv", () => {
  it("parses verb, --connection, and --to (the AC example)", () => {
    expect(
      parseArgv([
        "migration:up",
        "--connection",
        "analytics",
        "--to",
        "20260705",
      ])
    ).toEqual({
      command: "up",
      connection: "analytics",
      flags: { to: "20260705" },
    });
  });

  it("resolves connection to undefined when --connection is absent", () => {
    expect(parseArgv(["migration:list"])).toEqual({
      command: "list",
      connection: undefined,
      flags: {},
    });
  });

  it("recognizes every verb in the migration:<verb> grammar", () => {
    for (const verb of ["create", "up", "down", "list", "pending", "fresh"]) {
      expect(parseArgv([`migration:${verb}`]).command).toBe(verb);
    }
  });

  it("parses the create variant flags --blank and --initial", () => {
    expect(parseArgv(["migration:create", "--blank"]).flags).toEqual({
      blank: true,
    });
    expect(parseArgv(["migration:create", "--initial"]).flags).toEqual({
      initial: true,
    });
  });

  it("parses --force-drop as a boolean flag", () => {
    expect(parseArgv(["migration:fresh", "--force-drop"]).flags).toEqual({
      forceDrop: true,
    });
  });

  it("accepts the inline --key=value form", () => {
    expect(
      parseArgv(["migration:up", "--connection=analytics", "--to=20260705"])
    ).toMatchObject({ connection: "analytics", flags: { to: "20260705" } });
  });

  it("throws a clear error naming the verbs on an unknown verb", () => {
    expect(() => parseArgv(["migration:frobnicate"])).toThrow(
      /unknown migration command.*create, up, down, list, pending, fresh/s
    );
  });

  it("throws when the command is not the migration:<verb> grammar", () => {
    expect(() => parseArgv(["up"])).toThrow(/Expected "migration:<verb>"/);
  });

  it("throws when no command is given", () => {
    expect(() => parseArgv([])).toThrow(/no migration command given/);
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgv(["migration:up", "--conection", "x"])).toThrow(
      /unknown flag "--conection"/
    );
  });

  it("throws when a value flag has no value", () => {
    expect(() => parseArgv(["migration:up", "--connection"])).toThrow(
      /flag "--connection" requires a value/
    );
    expect(() => parseArgv(["migration:up", "--to", "--blank"])).toThrow(
      /flag "--to" requires a value/
    );
  });

  it("throws when a boolean flag is given a value", () => {
    expect(() => parseArgv(["migration:create", "--blank=true"])).toThrow(
      /flag "--blank" takes no value/
    );
  });
});
