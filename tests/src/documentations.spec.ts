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
 * - `loadDocumentations()` opens the changelog as the active tab after an
 *   update, and does not open it when the setting is off or the changelog for
 *   the current version was already read.
 *
 * `revealPrivateFilter` (the non-deprecated replacement) and `openExternal`
 * are external boundaries. `revealPrivateFilter` is used un-mocked from the
 * real library; its `try func / catch -> fallback` contract is evidenced by the
 * original issue's stack trace (`renderInstalledPlugin -> func ->
 * revealPrivateFilter -> donate`).
 *
 * `activeSelf` is stubbed to return `self` unconditionally: the real
 * implementation accepts `Element | UIEvent | null` but production code
 * passes a `Document` (from `containerEl.ownerDocument`), which jsdom does
 * not support — the stub keeps tests hermetic without coupling them to the
 * activeSelf internals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { addCommandSpy, openExternalSpy } = vi.hoisted(() => ({
  addCommandSpy: vi.fn<() => void>(),
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
    activeSelf: () => self,
    // Stub: the real addCommand needs a full plugin context to register
    // commands, which loadDocumentations() tests do not exercise.
    addCommand: addCommandSpy,
    openExternal: openExternalSpy,
  };
});

import { DocumentationMarkdownView } from "@polyipseity/obsidian-plugin-library";
import {
  DOCUMENTATIONS,
  loadDocumentations,
} from "../../src/documentations.js";

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
      language: { value: { t: () => "" } },
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
      const warnSpy = vi
        .spyOn(self.console, "warn")
        .mockImplementation(() => {});

      const listEl = self.document.createElement("ul");
      const { item, heartButton } = makePluginRow("Example Plugin");
      listEl.appendChild(item);
      const clickSpy = vi.spyOn(heartButton, "click");

      expect(() => {
        DOCUMENTATIONS.donate(
          {
            context: {
              language: { value: { t: () => "" } },
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
              manifest: { name: "Example Plugin", fundingUrl: {} },
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
      const warnSpy = vi
        .spyOn(self.console, "warn")
        .mockImplementation(() => {});

      // installedPlugins.listEl is null so the ?? falls through to groupEl.
      const pluginsGroupEl = self.document.createElement("div");
      const { item, heartButton } = makePluginRow("Example Plugin");
      pluginsGroupEl.appendChild(item);
      const clickSpy = vi.spyOn(heartButton, "click");

      expect(() => {
        DOCUMENTATIONS.donate(
          {
            context: {
              language: { value: { t: () => "" } },
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
              manifest: { name: "Example Plugin", fundingUrl: {} },
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
      const warnSpy = vi
        .spyOn(self.console, "warn")
        .mockImplementation(() => {});

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
      // The primary listEl path found no element — one app warning, then the
      // deprecated fallback threw and revealPrivateFilter emitted its own catch
      // warning before the fallback opened the donation URL.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      // The first warning is the JSON-serialized unmatched element (empty `<ul>`).
      expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({});
    });

    it("rethrows the original error when there is no usable donation URL", () => {
      openExternalSpy.mockClear();
      const warnSpy = vi
        .spyOn(self.console, "warn")
        .mockImplementation(() => {});

      expect(() => {
        DOCUMENTATIONS.donate(brokenDonateView(undefined), {
          active: true,
          event: null,
        });
      }).toThrow("addSetting");
      expect(openExternalSpy).not.toHaveBeenCalled();
      // One app warning from the primary listEl path, then revealPrivateFilter's
      // catch warning before the deprecated fallback rethrew the error.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      // The first warning is the JSON-serialized unmatched element (empty `<ul>`).
      expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({});
    });

    it("warns twice and opens the URL when both listEl and renderInstalledPlugin find no element", () => {
      openExternalSpy.mockClear();
      const warnSpy = vi
        .spyOn(self.console, "warn")
        .mockImplementation(() => {});

      // renderInstalledPlugin renders a node with no heart icon — unlike the
      // brokenDonateView helper it does not throw, so donate() reaches the
      // second warning and the inner throw before the revealPrivateFilter fallback.
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
              language: { value: { t: () => "" } },
              app: { setting: { settingTabs: [communityPluginsTab] } },
              manifest: { fundingUrl: "https://example.com/donate" },
            },
          } as unknown as Parameters<typeof DOCUMENTATIONS.donate>[0],
          { active: true, event: null },
        );
      }).not.toThrow();

      // First warn: primary listEl path. Second warn: deprecated path also
      // fails. Third warn: revealPrivateFilter's catch warning.
      expect(warnSpy).toHaveBeenCalledTimes(3);
      // Both warnings are JSON-serialized unmatched elements: the empty `<ul>`
      // and the rendered div containing only a `<span>` — both serialize to {}.
      expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({});
      expect(JSON.parse(String(warnSpy.mock.calls[1]?.[0]))).toEqual({});
      expect(openExternalSpy).toHaveBeenCalledTimes(1);
      expect(openExternalSpy.mock.calls[0]?.[1]).toBe(
        "https://example.com/donate",
      );
    });
  });

  describe("loadDocumentations()", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Build a plugin context on `version` whose last read changelog is
    // `lastReadChangelogVersion`, and stub the registered documentation view
    // so tests can assert how the changelog is opened.
    function setup(options: {
      readonly lastReadChangelogVersion: string;
      readonly openChangelogOnUpdate: boolean;
    }): {
      readonly context: Parameters<typeof loadDocumentations>[0];
      readonly openSpy: ReturnType<
        typeof vi.fn<DocumentationMarkdownView.Registered["open"]>
      >;
    } {
      const openSpy = vi
        .fn<DocumentationMarkdownView.Registered["open"]>()
        .mockResolvedValue(undefined);
      vi.spyOn(DocumentationMarkdownView, "register").mockReturnValue({
        open: openSpy,
      } as unknown as DocumentationMarkdownView.Registered);
      const context = {
        language: { value: { t: () => "" } },
        localSettings: {
          mutate: vi.fn().mockResolvedValue(undefined),
          value: {
            lastReadChangelogVersion: options.lastReadChangelogVersion,
          },
          write: vi.fn().mockResolvedValue(undefined),
        },
        settings: {
          value: { openChangelogOnUpdate: options.openChangelogOnUpdate },
        },
        version: "3.28.0",
      } as unknown as Parameters<typeof loadDocumentations>[0];
      return { context, openSpy };
    }

    it("opens the changelog as the active tab after an update", async () => {
      const { context, openSpy } = setup({
        lastReadChangelogVersion: "3.27.2",
        openChangelogOnUpdate: true,
      });

      loadDocumentations(context);

      await vi.waitFor(() => {
        expect(openSpy).toHaveBeenCalledTimes(1);
      });
      expect(openSpy.mock.calls[0]?.[0]).toBe(true);
    });

    it("does not open the changelog when the setting is off", async () => {
      const { context, openSpy } = setup({
        lastReadChangelogVersion: "3.27.2",
        openChangelogOnUpdate: false,
      });

      loadDocumentations(context);
      await Promise.resolve();

      expect(openSpy).not.toHaveBeenCalled();
    });

    it("does not open the changelog already read for this version", async () => {
      const { context, openSpy } = setup({
        lastReadChangelogVersion: "3.28.0",
        openChangelogOnUpdate: true,
      });

      loadDocumentations(context);
      await Promise.resolve();

      expect(openSpy).not.toHaveBeenCalled();
    });
  });
});
