/**
 * Tests for small test utilities in `tests/helpers.ts` — keep these fast and explicit.
 */
import { describe, it, expect } from "vitest";
import { microtasks, tick } from "./helpers.js";

describe("tests/helpers.ts utilities", () => {
  it("microtasks runs chained promise callbacks and no task", async () => {
    const ran: string[] = [];
    setImmediate(() => {
      ran.push("task");
    });
    void Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        ran.push("microtask");
      });

    await microtasks();
    expect(ran).toStrictEqual(["microtask"]);

    await tick();
    expect(ran).toStrictEqual(["microtask", "task"]);
  });

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
