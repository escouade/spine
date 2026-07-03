import { describe, it, expect } from "vitest";
import type { Envelope } from "@spinejs/gateway-core";
import { IpcLoggingInterceptor } from "./ipc-logging.interceptor";
import type { IpcRoute } from "./electron-ipc.gateway";
import type { ElectronIpcBaseContext } from "./electron-ipc-base.types";

const route = (address: string): IpcRoute =>
  ({ address, guards: [], invoke: () => undefined } as unknown as IpcRoute);

const ctx = {} as ElectronIpcBaseContext;

const okEnvelope = async (): Promise<Envelope<unknown>> => ({
  ok: true,
  data: undefined,
});

function captureDebug() {
  const messages: string[] = [];
  const logger = {
    debug: (message: unknown) => messages.push(String(message)),
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  };
  return { logger: logger as never, messages };
}

describe("IpcLoggingInterceptor", () => {
  it("logs the raw input verbatim when no redactor is supplied", async () => {
    const { logger, messages } = captureDebug();
    const interceptor = new IpcLoggingInterceptor(logger);

    await interceptor.intercept(
      route("auth:register"),
      ctx,
      ["alice@example.com", "s3cret", true],
      okEnvelope
    );

    expect(messages[0]).toContain("→ auth:register");
    expect(messages[0]).toContain("s3cret");
  });

  it("applies the redactor to the logged input, keeping the real input untouched", async () => {
    const { logger, messages } = captureDebug();
    const redact = (channel: string, input: unknown) =>
      channel.startsWith("auth:") ? "[redacted]" : input;
    const interceptor = new IpcLoggingInterceptor(logger, redact);
    const rawInput = ["alice@example.com", "s3cret", true];

    const envelope = await interceptor.intercept(
      route("auth:register"),
      ctx,
      rawInput,
      okEnvelope
    );

    expect(messages[0]).toContain("→ auth:register");
    expect(messages[0]).not.toContain("s3cret");
    expect(messages[0]).toContain("[redacted]");
    // The interceptor never mutates the input passed downstream.
    expect(rawInput).toEqual(["alice@example.com", "s3cret", true]);
    expect(envelope.ok).toBe(true);
  });

  it("leaves non-matching channels unredacted", async () => {
    const { logger, messages } = captureDebug();
    const redact = (channel: string, input: unknown) =>
      channel.startsWith("auth:") ? "[redacted]" : input;
    const interceptor = new IpcLoggingInterceptor(logger, redact);

    await interceptor.intercept(
      route("projects:list"),
      ctx,
      { limit: 10 },
      okEnvelope
    );

    expect(messages[0]).toContain('{"limit":10}');
  });

  it("logs the outbound error code on failure", async () => {
    const { logger, messages } = captureDebug();
    const interceptor = new IpcLoggingInterceptor(logger);

    await interceptor.intercept(route("auth:login"), ctx, [], async () => ({
      ok: false,
      code: "UNAUTHORIZED",
    }));

    expect(messages[1]).toContain("← auth:login error:UNAUTHORIZED");
  });
});
