/**
 * Unit tests for `src/documentations.ts`.
 *
 * Covers:
 * - `DOCUMENTATIONS.donate()` clicks the heart button when the plugin row is
 *   found via `installedPlugins.listEl` (primary path, Obsidian 1.12.7+).
 * - `DOCUMENTATIONS.donate()` clicks the heart button when the plugin row is
 *   found via `installedPlugins.groupEl` (secondary primary path).
 * - `DOCUMENTATIONS.donate()` falls back to the deprecated `renderInstalledPlugin`
 *   path when the primary path finds no matching row (older Obsidian versions).
 * - `DOCUMENTATIONS.donate()` falls back to opening the donation URL (and does
 *   not throw) when both paths fail — regression for Obsidian 1.12.7 private
 *   API change.
 * - `DOCUMENTATIONS.donate()` warns twice when both the listEl path and the
 *   deprecated renderInstalledPlugin path find no element, then opens the URL.
 *
 * `revealPrivate` and `openExternal` are external boundaries. `revealPrivate`
 * is emulated as a `try func / catch -> fallback` wrapper, matching the real
 * contract evidenced by the original issue's stack trace
 * (`renderInstalledPlugin -> func -> revealPrivate -> donate`).
 *
 * `activeSelf` is stubbed to return `self` unconditionally: the real
 * implementation accepts `Element | UIEvent | null` but production code
 * passes a `Document` (from `containerEl.ownerDocument`), which jsdom does
 * not support — the stub keeps tests hermetic without coupling them to the
 * activeSelf internals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { openExternalSpy } = vi.hoisted(() => ({
  openExternalSpy: vi.fn<(win: unknown, url: string) => void>(),
}));

vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return {
    ...actual,
    // Dynamic import is necessary here: this factory runs at module-mock time,
    // before the test module is loaded, so we must import the original first.
    // Stub: real activeSelf(Document) crashes in jsdom ("Cannot destructure
    // property 'defaultView'"); always returning `self` is safe for these tests.
    activeSelf: (() => self) as unknown as typeof actual.activeSelf,
    openExternal: openExternalSpy,
    revealPrivate: ((
      _context: unknown,
      args: readonly unknown[],
      func: (...a: readonly unknown[]) => unknown,
      fallback: (error: unknown) => unknown,
    ): unknown => {
      try {
        return func(...args);
      } catch (error) {
        return fallback(error);
      }
    }) as unknown as typeof actual.revealPrivate,
  };
});

import { DOCUMENTATIONS } from "../../src/documentations.js";

/**
 * Build a minimal DOM structure matching the installed-plugins list layout:
 *   .setting-item
 *     .setting-item-name (textContent = pluginName)
 *     button > svg.svg-icon.lucide-heart
 *
 * Returns the row element and the clickable heart button so tests can spy on
 * `click` and assert it was (or was not) invoked.
 */
function makePluginRow(pluginName: string): {
  item: HTMLDivElement;
  heartButton: HTMLButtonElement;
} {
  const item = self.document.createElement("div");
  item.className = "setting-item";
  const nameEl = self.document.createElement("div");
  nameEl.className = "setting-item-name";
  nameEl.textContent = pluginName;
  item.appendChild(nameEl);
  const heartSvg = self.document.createElement("svg");
  heartSvg.classList.add("svg-icon", "lucide-heart");
  const heartButton = self.document.createElement("button");
  heartButton.appendChild(heartSvg);
  item.appendChild(heartButton);
  return { item, heartButton };
}

// A donate `view` whose `installedPlugins.listEl` is empty (no matching row),
// so donate() falls through to the deprecated `renderInstalledPlugin` path,
// which always throws — simulating Obsidian 1.12.7's changed private API.
function brokenDonateView(
  donationUrl: string | Record<string, string> | undefined,
): Parameters<typeof DOCUMENTATIONS.donate>[0] {
  const communityPluginsTab = {
    id: "community-plugins",
    containerEl: self.document.createElement("div"),
    // Empty list: the new installedPlugins.listEl path finds no matching row
    // and falls through to the deprecated renderInstalledPlugin below.
    installedPlugins: { listEl: self.document.createElement("ul") },
    renderInstalledPlugin(): void {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'addSetting')",
      );
    },
  };
  return {
    context: {
      app: { setting: { settingTabs: [communityPluginsTab] } },
      manifest: { fundingUrl: donationUrl },
    },
  } as unknown as Parameters<typeof DOCUMENTATIONS.donate>[0];
}

describe("src/documentations.ts", () => {
  describe("DOCUMENTATIONS.donate()", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("clicks the heart button when the plugin row is found via installedPlugins.listEl", () => {
      openExternalSpy.mockClear();
      const warnSpy = vi.spyOn(self.console, "warn");

      const listEl = self.document.createElement("ul");
      const { item, heartButton } = makePluginRow("PLACEHOLDER");
      listEl.appendChild(item);
      const clickSpy = vi.spyOn(heartButton, "click");

      expect(() => {
        DOCUMENTATIONS.donate(
          {
            context: {
              app: {
                setting: {
                  settingTabs: [
                    {
                      id: "community-plugins",
                      containerEl: self.document.createElement("div"),
                      installedPlugins: { listEl },
                    },
                  ],
                },
              },
              manifest: { name: "PLACEHOLDER", fundingUrl: {} },
            },
          } as unknown as Parameters<typeof DOCUMENTATIONS.donate>[0],
          { active: true, event: null },
        );
      }).not.toThrow();

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(openExternalSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("clicks the heart button when the plugin row is found via installedPlugins.groupEl", () => {
      openExternalSpy.mockClear();
      const warnSpy = vi.spyOn(self.console, "warn");

      // installedPlugins.listEl is null so the ?? falls through to groupEl.
      const pluginsGroupEl = self.document.createElement("div");
      const { item, heartButton } = makePluginRow("PLACEHOLDER");
      pluginsGroupEl.appendChild(item);
      const clickSpy = vi.spyOn(heartButton, "click");

      expect(() => {
        DOCUMENTATIONS.donate(
          {
            context: {
              app: {
                setting: {
                  settingTabs: [
                    {
                      id: "community-plugins",
                      containerEl: self.document.createElement("div"),
                      installedPlugins: {
                        listEl: null as unknown as HTMLElement,
                        groupEl: pluginsGroupEl,
                      },
                    },
                  ],
                },
              },
              manifest: { name: "PLACEHOLDER", fundingUrl: {} },
            },
          } as unknown as Parameters<typeof DOCUMENTATIONS.donate>[0],
          { active: true, event: null },
        );
      }).not.toThrow();

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(openExternalSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("opens the donation URL and does not throw when renderInstalledPlugin fails", () => {
      openExternalSpy.mockClear();
      const warnSpy = vi.spyOn(self.console, "warn");

      expect(() => {
        DOCUMENTATIONS.donate(
          brokenDonateView({
            "Sponsor A": "https://example.com/donate-a",
            "Sponsor B": "https://example.com/donate-b",
          }),
          { active: true, event: null },
        );
      }).not.toThrow();

      expect(openExternalSpy).toHaveBeenCalledTimes(1);
      expect(openExternalSpy.mock.calls[0]?.[1]).toBe(
        "https://example.com/donate-a",
      );
      // The primary listEl path found no element — one warning before the
      // deprecated fallback was attempted (which then threw).
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("rethrows the original error when there is no usable donation URL", () => {
      openExternalSpy.mockClear();
      const warnSpy = vi.spyOn(self.console, "warn");

      expect(() => {
        DOCUMENTATIONS.donate(brokenDonateView(undefined), {
          active: true,
          event: null,
        });
      }).toThrow("addSetting");
      expect(openExternalSpy).not.toHaveBeenCalled();
      // One warning from the primary listEl path before the deprecated fallback
      // was attempted (which then threw the rethrown error).
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("warns twice and opens the URL when both listEl and renderInstalledPlugin find no element", () => {
      openExternalSpy.mockClear();
      const warnSpy = vi.spyOn(self.console, "warn");

      // renderInstalledPlugin renders a node with no heart icon — unlike the
      // brokenDonateView helper it does not throw, so donate() reaches the
      // second warning and the inner throw before the revealPrivate fallback.
      const communityPluginsTab = {
        id: "community-plugins",
        containerEl: self.document.createElement("div"),
        installedPlugins: { listEl: self.document.createElement("ul") },
        renderInstalledPlugin(_manifest: unknown, div: HTMLElement): void {
          div.appendChild(self.document.createElement("span"));
        },
      };

      expect(() => {
        DOCUMENTATIONS.donate(
          {
            context: {
              app: { setting: { settingTabs: [communityPluginsTab] } },
              manifest: { fundingUrl: "https://example.com/donate" },
            },
          } as unknown as Parameters<typeof DOCUMENTATIONS.donate>[0],
          { active: true, event: null },
        );
      }).not.toThrow();

      // First warn: primary listEl path. Second warn: deprecated path also fails.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(openExternalSpy).toHaveBeenCalledTimes(1);
      expect(openExternalSpy.mock.calls[0]?.[1]).toBe(
        "https://example.com/donate",
      );
    });
  });
});
