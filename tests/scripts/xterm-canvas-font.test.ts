// @vitest-environment node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  XTERM_CANVAS_FONT_FILTER,
  XTERM_CANVAS_FONT_SITES,
  loadXtermCanvasFontBundle,
  trimXtermCanvasFonts,
  xtermCanvasFont,
} from "../../scripts/xterm-canvas-font.mjs";

// Integration tests for scripts/xterm-canvas-font.mjs. Besides the unit
// cases, they read the installed xterm addon bundles, so an xterm upgrade
// that moves or fixes the font strings fails here as well as in the build.

const require = createRequire(import.meta.url),
  BUNDLES = [
    ["@xterm/addon-canvas", "lib/addon-canvas.js"],
    ["@xterm/addon-webgl", "lib/addon-webgl.js"],
    ["@xterm/addon-webgl", "lib/addon-webgl.mjs"],
  ] as const,
  // A font template that can start with a space and is not trimmed.
  UNTRIMMED = /`\$\{[^`]*?px \$\{[^`{}]*?fontFamily\}`(?!\.trim\(\))/u;

function bundlePath(pkg: string, file: string): string {
  return join(dirname(require.resolve(`${pkg}/package.json`)), file);
}

describe("trimXtermCanvasFonts", () => {
  it("trims a font template whose style can be empty", () => {
    const source =
      "a.font=`${s} ${w} ${this._config.fontSize*2}px ${this._config.fontFamily}`,b()";

    expect(trimXtermCanvasFonts(source)).toEqual({
      code: "a.font=`${s} ${w} ${this._config.fontSize*2}px ${this._config.fontFamily}`.trim(),b()",
      count: 1,
    });
  });

  it("leaves templates that are already trimmed or are not fonts", () => {
    const source =
      "a=`${s} ${w} ${n}px ${o.fontFamily}`.trim();b=`${x} ${y}`;c=`${n}px ${o.fontFamily}`.trim()";

    expect(trimXtermCanvasFonts(source)).toEqual({ code: source, count: 0 });
  });
});

describe("xterm addon bundles", () => {
  it.each(BUNDLES)("%s %s matches the build filter", (pkg, file) => {
    expect(XTERM_CANVAS_FONT_FILTER.test(bundlePath(pkg, file))).toBe(true);
  });

  it.each(BUNDLES)("%s %s has every font string trimmed", async (pkg, file) => {
    const { code, count } = trimXtermCanvasFonts(
      await readFile(bundlePath(pkg, file), "utf8"),
    );

    expect(count).toBe(XTERM_CANVAS_FONT_SITES);
    expect(UNTRIMMED.test(code)).toBe(false);
  });

  it("does not match other xterm bundles", () => {
    expect(
      XTERM_CANVAS_FONT_FILTER.test(bundlePath("@xterm/xterm", "lib/xterm.js")),
    ).toBe(false);
  });
});

describe("loadXtermCanvasFontBundle", () => {
  it("returns the trimmed bundle", async () => {
    const path = bundlePath("@xterm/addon-webgl", "lib/addon-webgl.js");

    await expect(loadXtermCanvasFontBundle(path)).resolves.toEqual({
      contents: trimXtermCanvasFonts(await readFile(path, "utf8")).code,
      loader: "js",
    });
  });

  it("fails when a bundle has a different number of font strings", async () => {
    const path = bundlePath("@xterm/xterm", "lib/xterm.js");

    await expect(loadXtermCanvasFontBundle(path)).rejects.toThrow(
      /Expected 2 canvas font strings/u,
    );
  });
});

describe("xtermCanvasFont", () => {
  it("is named after the workaround", () => {
    expect(xtermCanvasFont().name).toBe("xterm-canvas-font");
  });
});
