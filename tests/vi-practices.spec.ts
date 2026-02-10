import { describe, it, expect, vi, afterEach } from "vitest";

describe("Vitest / vi best-practices examples", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses vi.fn() for async stubs", async () => {
    const asyncStub = vi.fn().mockResolvedValue("ok");
    await expect(asyncStub()).resolves.toBe("ok");
    expect(asyncStub).toHaveBeenCalled();
  });

  it("uses fake timers for deterministic scheduling", () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    setTimeout(cb, 100);
    // advance time deterministically
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalled();
  });

  it("uses vi.spyOn to observe globals and restores automatically", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    console.log("hello");
    expect(logSpy).toHaveBeenCalledWith("hello");
  });
});
