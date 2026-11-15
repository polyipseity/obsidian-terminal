/**
 * Fixes the canvas font strings of xterm's canvas and WebGL renderers at build time.
 *
 * Both addons build a canvas font as `${fontStyle} ${fontWeight} ${size}px ${family}`. For text that
 * is not italic `fontStyle` is empty, so the string starts with a space. Chromium 150 (Obsidian 1.15)
 * ignores a canvas font that starts with a space and keeps the default `10px sans-serif`, so every
 * glyph is drawn tiny inside full-size cells. Trimming the string fixes it.
 *
 * Each addon bundle has two such strings: the glyph atlas and the render layers' `_getFont`. The
 * build fails when a bundle has a different number. After an xterm upgrade that means the code
 * moved or upstream fixed it: check, then update or remove this plugin.
 */
import { readFile } from "node:fs/promises";

/** Bundles of the xterm addons that draw text on a canvas. */
export const XTERM_CANVAS_FONT_FILTER =
  /[\\/]@xterm[\\/]addon-(?:canvas|webgl)[\\/]lib[\\/][^\\/]+\.m?js$/;

/** Font strings each matching bundle must contain. */
export const XTERM_CANVAS_FONT_SITES = 2;

/** A font template literal that ends in the font family and is not trimmed yet. */
const FONT_TEMPLATE = /`\$\{[^`]*?px \$\{[^`{}]*?fontFamily\}`(?!\.trim\(\))/gu;

/**
 * Appends `.trim()` to every canvas font template literal in a bundle.
 *
 * @param {string} source the bundle's code
 * @returns {{ readonly code: string, readonly count: number }} the new code and the number of templates trimmed
 */
export function trimXtermCanvasFonts(source) {
  let count = 0;
  const code = source.replace(FONT_TEMPLATE, (template) => {
    count += 1;
    return `${template}.trim()`;
  });
  return { code, count };
}

/**
 * Loads an xterm addon bundle with its canvas font strings trimmed.
 *
 * @param {string} path the bundle's path
 * @returns {Promise<{ readonly contents: string, readonly loader: "js" }>} the esbuild load result
 * @throws {Error} when the bundle does not have {@link XTERM_CANVAS_FONT_SITES} font strings
 */
export async function loadXtermCanvasFontBundle(path) {
  const { code, count } = trimXtermCanvasFonts(await readFile(path, "utf8"));
  if (count !== XTERM_CANVAS_FONT_SITES) {
    throw new Error(
      `Expected ${String(XTERM_CANVAS_FONT_SITES)} canvas font strings in ${path}, found ${String(count)}. See scripts/xterm-canvas-font.mjs.`,
    );
  }
  return { contents: code, loader: "js" };
}

/**
 * An esbuild plugin that trims the canvas font strings of xterm's canvas and WebGL addons.
 *
 * @returns {import("esbuild").Plugin} the plugin
 */
export function xtermCanvasFont() {
  return {
    name: "xterm-canvas-font",
    setup(build) {
      build.onLoad({ filter: XTERM_CANVAS_FONT_FILTER }, ({ path }) =>
        loadXtermCanvasFontBundle(path),
      );
    },
  };
}
