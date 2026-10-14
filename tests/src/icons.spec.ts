/**
 * Unit tests for `src/icons.ts`: icon ids and what gets registered at load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bezelIconId,
  loadIcons,
  tabIconId,
  tileIconId,
} from "../../src/icons.js";
import type { TerminalPlugin } from "../../src/main.js";
import { Settings } from "../../src/settings-data.js";
import {
  composeTabIcon,
  composeTileIcon,
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

describe("bezelIconId", () => {
  it("keeps the id that saved layouts name: terminal:tab-bezel", () => {
    expect(bezelIconId(context)).toBe("terminal:tab-bezel");
  });
});

describe("tileIconId", () => {
  it("names the rounded square terminal:tab-tile, as earlier builds saved it", () => {
    expect(tileIconId(context)).toBe("terminal:tab-tile");
    expect(tileIconId(context)).not.toBe(bezelIconId(context));
  });
});

describe("tabIconId", () => {
  it.each([
    ["none", "terminal:tab-tile"],
    ["still", "terminal:tab-bezel"],
    ["animated", "terminal:tab-bezel"],
  ] as const)(
    "is the icon a terminal tab shows under %s: %s",
    (tabStatus, id) => {
      expect(tabIconId(context, { tabStatus })).toBe(id);
    },
  );

  it("covers every Program status", () => {
    expect(
      Settings.TAB_STATUSES.map((tabStatus) =>
        tabIconId(context, { tabStatus }),
      ),
    ).toEqual([
      tileIconId(context),
      bezelIconId(context),
      bezelIconId(context),
    ]);
  });
});

describe("loadIcons", () => {
  beforeEach(() => {
    vi.mocked(registerIcon).mockClear();
  });

  it("registers the tab icon and the tile icon, with the composed content", () => {
    loadIcons(context);
    expect(registerIcon).toHaveBeenCalledWith(
      context,
      "terminal:tab-bezel",
      composeTabIcon(),
    );
    expect(registerIcon).toHaveBeenCalledWith(
      context,
      "terminal:tab-tile",
      composeTileIcon(),
    );
  });

  it("registers exactly these and the platform icons", () => {
    loadIcons(context);
    const ids = vi.mocked(registerIcon).mock.calls.map((call) => call[1]);
    expect(ids).toEqual([
      "terminal:linux",
      "terminal:macos",
      "terminal:tab-bezel",
      "terminal:tab-tile",
    ]);
    // One drawing for the ribbon and for a tab under None.
    expect(ids).not.toContain("terminal:ribbon");
  });
});
