/**
 * Small unit tests for `src/magic.ts` constants — ensure exported constants are sane.
 */
import { describe, it, expect } from "vitest";
import { PLUGIN_UNLOAD_DELAY, DOMClasses2 } from "../../src/magic.js";

describe("src/magic.ts", () => {
  it("exports PLUGIN_UNLOAD_DELAY as a number", () => {
    expect(typeof PLUGIN_UNLOAD_DELAY).toBe("number");
    expect(PLUGIN_UNLOAD_DELAY).toBeGreaterThanOrEqual(0);
  });

  it("exports DOMClasses2 constants", () => {
    expect(DOMClasses2).toHaveProperty("LUCIDE_HEART");
    expect(DOMClasses2).toHaveProperty("SVG_ICON");
    expect(typeof DOMClasses2.LUCIDE_HEART).toBe("string");
    expect(typeof DOMClasses2.SVG_ICON).toBe("string");
  });
});
