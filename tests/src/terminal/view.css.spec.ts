/**
 * `view.css` styles one thing outside the terminal view: the tab header, to
 * hide a reveal flash that Obsidian draws wrongly. These checks keep that rule
 * off the tabs of other views and off tab headers that draw the flash well.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read by filesystem path: Vite rewrites `new URL(<literal>, import.meta.url)`.
const CSS = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../src/terminal/view.css",
    ),
    "utf8",
  ),
  TERMINAL_TAB = '.workspace-tab-header[data-type="terminal\\:terminal"]';

/** The selector of every rule, without comments and with whitespace collapsed. */
function selectors(css: string): readonly string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
    .flatMap(([, list = ""]) => list.split(","))
    .map((selector) => selector.trim().replace(/\s+/gu, " "));
}

describe("src/terminal/view.css", () => {
  const tabHeaderSelectors = selectors(CSS).filter((selector) =>
    selector.includes(".workspace-tab-header"),
  );

  it("styles the tab headers of terminals only", () => {
    expect(tabHeaderSelectors).not.toHaveLength(0);
    for (const selector of tabHeaderSelectors) {
      expect(selector).toContain(TERMINAL_TAB);
    }
  });

  it("hides the reveal flash only where the tab's corner curves are drawn", () => {
    // Obsidian draws the curves with this same prefix, on the active tab only.
    // Sidebar tabs and stacked tabs have none and show the flash correctly.
    const flashing = `.workspace-split.mod-root .workspace-tab-header-container ${TERMINAL_TAB}.is-active.is-flashing`;
    expect(
      tabHeaderSelectors.filter((selector) =>
        selector.includes(".is-flashing"),
      ),
    ).toStrictEqual([flashing]);
    expect(CSS.replace(/\s+/gu, " ")).toContain(
      `${flashing} { background-color: var(--tab-background-active) !important; mix-blend-mode: normal; }`,
    );
  });
});
