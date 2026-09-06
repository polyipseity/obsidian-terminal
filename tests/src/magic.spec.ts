/**
 * Small unit tests for `src/magic.ts` constants — ensure exported constants are sane.
 */
import { describe, it, expect } from "vitest";
import {
  PLUGIN_UNLOAD_DELAY,
  DOMClasses2,
  TERMINAL_CONPTY_RESIZE_REPAINT_WINDOW,
  TERMINAL_OUTPUT_HIGH_WATER_BYTES,
  TERMINAL_OUTPUT_LOW_WATER_BYTES,
  TERMINAL_OUTPUT_WRITE_SLICE_BYTES,
  TERMINAL_PTY_RESIZE_WAIT,
} from "../../src/magic.js";

describe("src/magic.ts", () => {
  it("keeps the flow-control geometry ordered", () => {
    expect(TERMINAL_OUTPUT_WRITE_SLICE_BYTES).toBeGreaterThan(0);
    expect(TERMINAL_OUTPUT_LOW_WATER_BYTES).toBeGreaterThan(
      TERMINAL_OUTPUT_WRITE_SLICE_BYTES,
    );
    expect(TERMINAL_OUTPUT_HIGH_WATER_BYTES).toBeGreaterThan(
      TERMINAL_OUTPUT_LOW_WATER_BYTES,
    );
  });

  it("keeps the ConPTY repaint window covering a drag step", () => {
    expect(TERMINAL_CONPTY_RESIZE_REPAINT_WINDOW).toBeGreaterThan(
      TERMINAL_PTY_RESIZE_WAIT,
    );
    expect(TERMINAL_CONPTY_RESIZE_REPAINT_WINDOW).toBeLessThanOrEqual(1);
  });

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
