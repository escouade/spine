import { describe, expect, it } from "vitest";
import type { JsonSchemaObject } from "@spinejs/gateway-core";
import { ComponentRegistry } from "./component-registry";

const objA: JsonSchemaObject = {
  type: "object",
  properties: { a: { type: "string" } },
};
const objB: JsonSchemaObject = {
  type: "object",
  properties: { b: { type: "number" } },
};

describe("ComponentRegistry", () => {
  it("names an anonymous schema from its derived base and $refs it", () => {
    const registry = new ComponentRegistry();
    const ref = registry.register(objA, { derivedBase: "CreateUser_Body" });
    expect(ref).toBe("#/components/schemas/CreateUser_Body");
    expect(registry.toSchemas()).toEqual({ CreateUser_Body: objA });
  });

  it("names a schema from its authored id (AD-8 precedence)", () => {
    const registry = new ComponentRegistry();
    const ref = registry.register(objA, {
      authoredId: "User",
      derivedBase: "CreateUser_Body",
    });
    expect(ref).toBe("#/components/schemas/User");
    expect(Object.keys(registry.toSchemas() ?? {})).toEqual(["User"]);
  });

  it("deduplicates identical content under the same base", () => {
    const registry = new ComponentRegistry();
    const first = registry.register(objA, { derivedBase: "X_Body" });
    const second = registry.register(objA, { derivedBase: "X_Body" });
    expect(first).toBe(second);
    expect(Object.keys(registry.toSchemas() ?? {})).toEqual(["X_Body"]);
  });

  it("suffixes on a same-name / different-content collision", () => {
    const registry = new ComponentRegistry();
    const first = registry.register(objA, { derivedBase: "X_Body" });
    const second = registry.register(objB, { derivedBase: "X_Body" });
    expect(first).toBe("#/components/schemas/X_Body");
    expect(second).toBe("#/components/schemas/X_Body_2");
  });

  it("keeps input vs output projections distinct when they differ (AD-8, io)", () => {
    const registry = new ComponentRegistry();
    // Same authored id, different content (e.g. an input vs output projection).
    const input = registry.register(objA, {
      authoredId: "User",
      derivedBase: "X_Body",
    });
    const output = registry.register(objB, {
      authoredId: "User",
      derivedBase: "X_Response",
    });
    expect(input).toBe("#/components/schemas/User");
    expect(output).toBe("#/components/schemas/User_2");
  });

  it("never lets a derived name squat a reserved authored id", () => {
    const registry = new ComponentRegistry();
    registry.register(objA, { authoredId: "Widget", derivedBase: "A_Body" });
    // A later anonymous schema whose derived base equals the reserved id must be suffixed.
    const ref = registry.register(objB, { derivedBase: "Widget" });
    expect(ref).toBe("#/components/schemas/Widget_2");
  });

  it("emits components in sorted key order, undefined when empty", () => {
    const registry = new ComponentRegistry();
    expect(registry.toSchemas()).toBeUndefined();
    registry.register(objA, { derivedBase: "Zebra" });
    registry.register(objB, { derivedBase: "Alpha" });
    expect(Object.keys(registry.toSchemas() ?? {})).toEqual(["Alpha", "Zebra"]);
  });
});
