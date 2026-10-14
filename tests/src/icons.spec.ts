/**
 * Unit tests for `src/icons.ts`: icon ids and what gets registered at load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIcons, ribbonIconId, tabIconId } from "../../src/icons.js";
import type { TerminalPlugin } from "../../src/main.js";
import {
  composeRibbonIcon,
  composeTabIcon,
} from "../../src/terminal/tab-icons.js";
import { registerIcon } from "@polyipseity/obsidian-plugin-library";

vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@polyipseity/obsidian-plugin-library")
  >()),
  registerIcon: vi.fn(),
}));

// `UnnamespacedID.namespaced` reads only the manifest id; a whole plugin is
// not needed to name an icon, so the context is a stand-in (as in other specs).
const context = { id: "terminal" } as unknown as TerminalPlugin;

describe("tabIconId", () => {
  it("keeps the id that saved layouts name: terminal:tab-bezel", () => {
    expect(tabIconId(context)).toBe("terminal:tab-bezel");
  });
});

describe("ribbonIconId", () => {
  it("names the ribbon's icon terminal:ribbon, apart from the tab's", () => {
    expect(ribbonIconId(context)).toBe("terminal:ribbon");
    expect(ribbonIconId(context)).not.toBe(tabIconId(context));
  });
});

describe("loadIcons", () => {
  beforeEach(() => {
    vi.mocked(registerIcon).mockClear();
  });

  it("registers the tab icon and the ribbon icon, with the composed content", () => {
    loadIcons(context);
    expect(registerIcon).toHaveBeenCalledWith(
      context,
      "terminal:tab-bezel",
      composeTabIcon(),
    );
    expect(registerIcon).toHaveBeenCalledWith(
      context,
      "terminal:ribbon",
      composeRibbonIcon(),
    );
  });

  it("registers exactly these and the platform icons", () => {
    loadIcons(context);
    const ids = vi.mocked(registerIcon).mock.calls.map((call) => call[1]);
    expect(ids).toEqual([
      "terminal:linux",
      "terminal:macos",
      "terminal:tab-bezel",
      "terminal:ribbon",
    ]);
    // The drawing in lines alone is the ribbon's now, under its own id.
    expect(ids).not.toContain("terminal:tab-tile");
  });
});
