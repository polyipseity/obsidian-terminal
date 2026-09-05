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
    expect(DOMClasses2).toHaveProperty("COLOR_PROBE");
    expect(DOMClasses2).toHaveProperty("FULL_WIDTH");
    expect(DOMClasses2).toHaveProperty("HIDDEN");
    expect(DOMClasses2).toHaveProperty("LUCIDE_HEART");
    expect(DOMClasses2).toHaveProperty("SETTING_ITEM");
    expect(DOMClasses2).toHaveProperty("SETTING_ITEM_NAME");
    expect(DOMClasses2).toHaveProperty("SVG_ICON");
    expect(typeof DOMClasses2.COLOR_PROBE).toBe("string");
    expect(typeof DOMClasses2.FULL_WIDTH).toBe("string");
    expect(typeof DOMClasses2.HIDDEN).toBe("string");
    expect(typeof DOMClasses2.LUCIDE_HEART).toBe("string");
    expect(typeof DOMClasses2.SETTING_ITEM).toBe("string");
    expect(typeof DOMClasses2.SETTING_ITEM_NAME).toBe("string");
    expect(typeof DOMClasses2.SVG_ICON).toBe("string");
    expect(DOMClasses2.COLOR_PROBE).toBe("terminal:color-probe");
    expect(DOMClasses2.FULL_WIDTH).toBe("terminal:full-width");
    expect(DOMClasses2.HIDDEN).toBe("terminal:hidden");
  });
});
