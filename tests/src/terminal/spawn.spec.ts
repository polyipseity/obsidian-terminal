/**
 * Unit tests for `src/terminal/spawn.ts`: what the profile selector lists.
 */
import { describe, expect, it, vi } from "vitest";
import { pythonSettingsContext } from "../../fixtures/python-settings-ui.js";
import { LocalSettings, Settings } from "../../../src/settings-data.js";
import { SelectProfileModal } from "../../../src/terminal/spawn.js";

vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return { ...actual, Platform: { ...actual.Platform, CURRENT: "darwin" } };
});
// The selector opens terminals through the view; its items need none.
vi.mock("../../../src/terminal/view.js", () => ({
  EditTerminalModal: vi.fn(),
  TerminalView: {},
}));

describe("profile selector", () => {
  it("lists the temporary profile, then the profiles that run here in this device's order", async () => {
    const integrated = Settings.Profile.DEFAULTS.integrated,
      context = await pythonSettingsContext({
        profiles: {
          zsh: { ...integrated, platforms: { darwin: true } },
          pwsh: { ...integrated, platforms: { win32: true } },
          bash: { ...integrated, platforms: { darwin: true } },
          fish: { ...integrated, platforms: { darwin: true } },
        },
      });
    Object.assign(context.localSettings, {
      value: LocalSettings.fix({
        lastReadChangelogVersion: "0.0.0",
        profileOrder: ["fish", "pwsh", "constructor", "zsh"],
      }).value,
    });
    // The items need only the plugin; no modal is opened.
    const items = SelectProfileModal.prototype.getItems.call({
      context,
    } as unknown as SelectProfileModal);
    expect(items.map((item) => item?.[0] ?? null)).toEqual([
      null,
      "fish",
      "zsh",
      "bash",
    ]);
  });
});
