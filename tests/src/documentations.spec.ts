/**
 * Unit tests for `src/documentations.ts`.
 *
 * Covers:
 * - `donationUrls()` normalizes `manifest.fundingUrl` (string | record | nullish).
 * - `DOCUMENTATIONS.donate()` falls back to opening the donation URL (and does
 *   not throw) when the private `renderInstalledPlugin` path fails — regression
 *   for polyipseity/obsidian-terminal#157 (Obsidian 1.12.7 private API change).
 *
 * `revealPrivate` and `openExternal` are external boundaries. `revealPrivate`
 * is emulated as a `try func / catch -> fallback` wrapper, matching the real
 * contract evidenced by issue #157's stack trace
 * (`renderInstalledPlugin -> func -> revealPrivate -> donate`).
 */
import { describe, it, expect, vi } from "vitest";

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

import { donationUrls, DOCUMENTATIONS } from "../../src/documentations.js";

// A donate `view` whose private `renderInstalledPlugin` path always throws,
// simulating Obsidian 1.12.7's changed private API (issue #157).
function brokenDonateView(
  donationUrl: string | Record<string, string> | undefined,
): Parameters<typeof DOCUMENTATIONS.donate>[0] {
  const communityPluginsTab = {
    id: "community-plugins",
    containerEl: self.document.createElement("div"),
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
  describe("donationUrls()", () => {
    it("wraps a single string URL", () => {
      expect(donationUrls("https://buymeacoffee.com/polyipseity")).toEqual([
        "https://buymeacoffee.com/polyipseity",
      ]);
    });

    it("returns the values of a label->url record in order", () => {
      expect(
        donationUrls({
          "Buy Me a Coffee": "https://buymeacoffee.com/polyipseity",
          "GitHub Sponsors": "https://github.com/sponsors/polyipseity",
        }),
      ).toEqual([
        "https://buymeacoffee.com/polyipseity",
        "https://github.com/sponsors/polyipseity",
      ]);
    });

    it("returns an empty array for undefined", () => {
      expect(donationUrls(undefined)).toEqual([]);
    });

    it("returns an empty array for an empty record", () => {
      expect(donationUrls({})).toEqual([]);
    });

    // Empty strings pass through; `donate()` guards against them with `!url`.
    it("preserves an empty string", () => {
      expect(donationUrls("")).toEqual([""]);
    });
  });

  describe("DOCUMENTATIONS.donate()", () => {
    it("opens the donation URL and does not throw when renderInstalledPlugin fails", () => {
      openExternalSpy.mockClear();

      expect(() => {
        DOCUMENTATIONS.donate(
          brokenDonateView({
            "Buy Me a Coffee": "https://buymeacoffee.com/polyipseity",
            "GitHub Sponsors": "https://github.com/sponsors/polyipseity",
          }),
        );
      }).not.toThrow();

      expect(openExternalSpy).toHaveBeenCalledTimes(1);
      expect(openExternalSpy.mock.calls[0]?.[1]).toBe(
        "https://buymeacoffee.com/polyipseity",
      );
    });

    it("rethrows the original error when there is no usable donation URL", () => {
      openExternalSpy.mockClear();

      expect(() => {
        DOCUMENTATIONS.donate(brokenDonateView(""));
      }).toThrow("addSetting");
      expect(openExternalSpy).not.toHaveBeenCalled();
    });
  });
});
