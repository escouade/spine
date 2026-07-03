import { Timer, isObject, merge } from "./utils";

describe("isObject", () => {
  it("is true for plain object literals", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it("is false for non-plain values", () => {
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject("str")).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(new Date())).toBe(false);
  });
});

describe("merge", () => {
  it("deep-merges plain objects, later source winning", () => {
    const out = merge(
      { a: 1, nested: { x: 1, y: 2 } },
      { nested: { y: 3, z: 4 } }
    );
    expect(out).toEqual({ a: 1, nested: { x: 1, y: 3, z: 4 } });
  });

  it("mutates and returns the first argument", () => {
    const target = { a: 1 };
    const out = merge(target, { b: 2 });
    expect(out).toBe(target);
    expect(target).toEqual({ a: 1, b: 2 });
  });

  it("skips undefined source values", () => {
    const out = merge({ a: 1, b: 2 }, { a: undefined, b: 3 });
    expect(out).toEqual({ a: 1, b: 3 });
  });

  it("merges arrays by index and keeps extra destination elements", () => {
    const out = merge({ list: [1, 2, 3] }, { list: [10, 20] });
    expect(out).toEqual({ list: [10, 20, 3] });
  });

  it("merges objects nested inside arrays", () => {
    const out = merge({ list: [{ a: 1, b: 1 }] }, { list: [{ b: 2 }] });
    expect(out).toEqual({ list: [{ a: 1, b: 2 }] });
  });

  it("replaces non-plain values (Date, class instances) by reference", () => {
    const date = new Date();
    const out = merge<{ d?: Date }>({}, { d: date });
    expect(out.d).toBe(date);
  });

  it("does not share references with the source for fresh objects", () => {
    const source = { nested: { x: 1 } };
    const out = merge<{ nested?: { x: number } }>({}, source);
    expect(out.nested).toEqual({ x: 1 });
    expect(out.nested).not.toBe(source.nested);
  });

  it("applies multiple sources left to right", () => {
    const out = merge({ a: 1 }, { a: 2, b: 2 }, { b: 3 });
    expect(out).toEqual({ a: 2, b: 3 });
  });
});

describe("Timer", () => {
  it("returns elapsed time as a string with the requested precision", () => {
    const timer = new Timer();
    timer.start("job");
    const elapsed = timer.getTime("job", 2);
    expect(typeof elapsed).toBe("string");
    expect(elapsed).toMatch(/^\d+\.\d{2}$/);
    expect(Number(elapsed)).toBeGreaterThanOrEqual(0);
  });

  it("throws for an unknown timer id", () => {
    expect(() => new Timer().getTime("missing")).toThrow(/invalid timer id/);
  });

  it("clears the timer after reading unless asked to keep it", () => {
    const timer = new Timer();
    timer.start("once");
    timer.getTime("once");
    expect(() => timer.getTime("once")).toThrow(/invalid timer id/);
  });

  it("returns elapsed time as a non-negative number and clears the id", () => {
    const timer = new Timer();
    timer.start("job");
    const elapsed = timer.elapsed("job");
    expect(typeof elapsed).toBe("number");
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(() => timer.elapsed("job")).toThrow(/invalid timer id/);
  });
});
