import { vi } from "vitest";
import { AppLogger } from "./logger";

/** Captures everything written to stdout/stderr during `fn`. */
function capture(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, err };
}

const opts = { appName: "Test", console: { colors: false, processId: false } };

describe("AppLogger", () => {
  it("writes info to stdout with the message and context", () => {
    const { out, err } = capture(() =>
      new AppLogger(opts).info("hello", "Ctx")
    );
    expect(err).toHaveLength(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("hello");
    expect(out[0]).toContain("[Ctx]");
    expect(out[0]).toContain("[Test]");
    expect(out[0]).toContain("LOG"); // info rendered as "log"
    expect(out[0].endsWith("\n")).toBe(true);
  });

  it("routes warn/error/fatal to stderr", () => {
    const logger = new AppLogger(opts);
    const { out, err } = capture(() => {
      logger.warn("w");
      logger.error("e");
      logger.fatal("f");
    });
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(3);
  });

  it("filters out levels below the configured threshold", () => {
    const logger = new AppLogger({ ...opts, level: "warn" });
    const { out, err } = capture(() => {
      logger.info("hidden");
      logger.debug("hidden");
      logger.warn("shown");
    });
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("shown");
  });

  it("renders an Error message with its stack", () => {
    const logger = new AppLogger(opts);
    const { err } = capture(() => logger.error(new Error("boom")));
    expect(err[0]).toContain("boom");
    expect(err[0]).toContain("at "); // stack frames
  });

  it("appends a trailing object as metadata", () => {
    const logger = new AppLogger(opts);
    const { out } = capture(() => logger.info("msg", { userId: 42 }));
    expect(out[0]).toContain("userId");
    expect(out[0]).toContain("42");
  });

  it("does not write when stdout is disabled", () => {
    const logger = new AppLogger({ ...opts, stdout: false });
    const { out, err } = capture(() => {
      logger.info("nope");
      logger.error("nope");
    });
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(0);
  });
});
