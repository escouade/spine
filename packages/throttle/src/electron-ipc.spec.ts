import { describe, expect, it } from "vitest";
import type { GatewayContext } from "@spinejs/gateway-core";
import { senderKeySource } from "./electron-ipc";

// Unit coverage for the 'sender' key source, mirroring ipKeySource's missing-address tests
// (http-preset.spec.ts): a fail-closed selector is only safe if its throw path is pinned.
describe("'sender' key source (electron IPC, FR-5)", () => {
  const ctxWith = (event: unknown): GatewayContext =>
    ({ event } as unknown as GatewayContext);

  it("keys an IPC call by the sender's WebContents id", () => {
    expect(senderKeySource()(ctxWith({ sender: { id: 7 } }), undefined)).toBe(
      "sender:7"
    );
  });

  it("throws (→ failure policy, fail-closed default) when the sender id is missing", () => {
    // No `event` at all (not an IPC ctx).
    expect(() => senderKeySource()({} as GatewayContext, undefined)).toThrow(
      /ctx\.event\.sender is missing/
    );
    // `event` present but no `sender`.
    expect(() => senderKeySource()(ctxWith({}), undefined)).toThrow(
      /ctx\.event\.sender is missing/
    );
    // `sender` present but no numeric `id` — a shared bucket must never fall back here.
    expect(() => senderKeySource()(ctxWith({ sender: {} }), undefined)).toThrow(
      /ctx\.event\.sender is missing/
    );
    expect(() =>
      senderKeySource()(ctxWith({ sender: { id: "7" } }), undefined)
    ).toThrow(/ctx\.event\.sender is missing/);
  });
});
