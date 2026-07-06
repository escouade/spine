import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildStorageKey, hashKey } from "./key-pipeline";

describe("key pipeline (AD-5, Story 1.5)", () => {
  it("hashes with sha256 truncated to 16 bytes (32 hex chars), deterministically", () => {
    const hash = hashKey("alice@example.com");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toBe(hashKey("alice@example.com"));
    expect(hash).toBe(
      createHash("sha256")
        .update("alice@example.com")
        .digest("hex")
        .slice(0, 32)
    );
  });

  it("separates distinct raw keys", () => {
    expect(hashKey("alice@example.com")).not.toBe(hashKey("bob@example.com"));
  });

  it("keeps only the hash at the store boundary — raw key material never appears", () => {
    const storageKey = buildStorageKey("POST /login", "alice@example.com");
    // scope stays legible (framework-controlled), the subject is hash-only (attacker-controlled).
    expect(storageKey).toBe(`POST /login:${hashKey("alice@example.com")}`);
    expect(storageKey).not.toContain("alice");
    expect(storageKey).not.toContain("@");
  });

  it("scopes per route target vs gateway-wide", () => {
    const raw = "203.0.113.7";
    expect(buildStorageKey("GET /a", raw)).not.toBe(
      buildStorageKey("GET /b", raw)
    );
    expect(buildStorageKey("gateway", raw)).toBe(
      buildStorageKey("gateway", raw)
    );
  });
});
