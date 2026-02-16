/**
 * Tests for small test utilities in `tests/helpers.ts` — keep these fast and explicit.
 */
import { describe, it, expect } from "vitest";
import { tick } from "./helpers.js";

describe("tests/helpers.ts utilities", () => {
  it("tick waits for next macrotask (setImmediate)", async () => {
    let called = false;
    setImmediate(() => {
      called = true;
    });

    // not yet executed synchronously
    expect(called).toBe(false);

    // tick() resolves after the next macrotask (setImmediate)
    await tick();
    expect(called).toBe(true);
  });
});
