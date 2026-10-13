/**
 * Unit tests for `src/icons.ts`: icon ids and what gets registered at load.
 */
import { createInstance } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import asset from "../../assets/locales/en/asset.json" with { type: "json" };
import { loadIcons, tabIconId, terminalIconId } from "../../src/icons.js";
import { Settings } from "../../src/settings-data.js";
import type { TerminalPlugin } from "../../src/main.js";
import { composeTabIcon } from "../../src/terminal/tab-icons.js";
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
  it.each(Settings.TAB_ICON_SETS)(
    "names the %s set terminal:tab-<set>",
    (set) => {
      expect(tabIconId(context, set)).toBe(`terminal:tab-${set}`);
    },
  );
});

describe("terminalIconId", () => {
  it("is the icon a terminal tab has had since before there were icon sets", async () => {
    const i18n = createInstance();
    await i18n.init({
      fallbackLng: false,
      lng: "en",
      ns: ["asset"],
      resources: { en: { asset } },
    });
    // Only the translations are read; the rest of the plugin is not needed.
    expect(
      terminalIconId({
        language: { value: i18n },
      } as unknown as TerminalPlugin),
    ).toBe("terminal");
  });
});

describe("loadIcons", () => {
  beforeEach(() => {
    vi.mocked(registerIcon).mockClear();
  });

  it("registers one tab icon per set, with the composed content", () => {
    loadIcons(context);
    for (const set of Settings.TAB_ICON_SETS) {
      expect(registerIcon).toHaveBeenCalledWith(
        context,
        `terminal:tab-${set}`,
        composeTabIcon(set),
      );
    }
  });

  it("keeps the platform icons", () => {
    loadIcons(context);
    const ids = vi.mocked(registerIcon).mock.calls.map((call) => call[1]);
    expect(ids).toEqual([
      "terminal:linux",
      "terminal:macos",
      ...Settings.TAB_ICON_SETS.map((set) => `terminal:tab-${set}`),
    ]);
  });

  it("registers exactly the two tab icons", () => {
    loadIcons(context);
    expect(
      vi
        .mocked(registerIcon)
        .mock.calls.map((call) => call[1])
        .filter((id) => id.startsWith("terminal:tab-")),
    ).toEqual(["terminal:tab-bezel", "terminal:tab-tile"]);
  });
});
