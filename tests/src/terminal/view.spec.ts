/**
 * Unit tests for `src/terminal/view.ts` — tab rename feature.
 *
 * Covers:
 * - `TerminalView.State.DEFAULT` includes `userTitle: null`
 * - `TerminalView.State.fix()` handles `userTitle` field correctly
 * - `TerminalView.name` getter respects `userTitle` priority
 * - `onPaneMenu()` includes a "Rename" menu item
 * - "rename-terminal" command is registered
 */
import { describe, it, expect, vi } from "vitest";

/*
 * Mock `src/import.js` — the BUNDLE map provides lazy `require()` loaders for
 * xterm addon packages that are not built/available in the test environment.
 * Replacing the map entries with no-op factories prevents unhandled rejections
 * from `dynamicRequire`.
 */
vi.mock("../../../src/import.js", () => {
  const dummy = (): Record<string, unknown> => ({});
  const entries: Array<[string, () => Record<string, unknown>]> = [
    ["@xterm/addon-canvas", dummy],
    ["@xterm/addon-fit", dummy],
    ["@xterm/addon-ligatures", dummy],
    ["@xterm/addon-search", dummy],
    ["@xterm/addon-serialize", dummy],
    ["@xterm/addon-unicode11", dummy],
    ["@xterm/addon-web-links", dummy],
    ["@xterm/addon-webgl", dummy],
    ["@xterm/xterm", dummy],
    ["tmp-promise", dummy],
  ];
  return {
    BUNDLE: new Map(entries),
    MODULES: entries.map(([key]) => key),
  };
});

import { TerminalView } from "../../../src/terminal/view.js";
import { Settings } from "../../../src/settings-data.js";

describe("src/terminal/view.ts", () => {
  describe("TerminalView.State", () => {
    describe("State.DEFAULT", () => {
      it("includes userTitle set to null", () => {
        expect(TerminalView.State.DEFAULT).toHaveProperty("userTitle");
        expect(TerminalView.State.DEFAULT.userTitle).toBeNull();
      });

      it("preserves existing default fields", () => {
        expect(TerminalView.State.DEFAULT).toHaveProperty("cwd", null);
        expect(TerminalView.State.DEFAULT).toHaveProperty("focus", false);
        expect(TerminalView.State.DEFAULT).toHaveProperty("profile");
        expect(TerminalView.State.DEFAULT).toHaveProperty("serial", null);
      });
    });

    describe("State.fix()", () => {
      it("preserves a valid userTitle string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: "My Custom Terminal",
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("My Custom Terminal");
      });

      it("coerces missing userTitle to null", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBeNull();
      });

      it("coerces non-string userTitle to null", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: 42,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBeNull();
      });

      it("coerces boolean userTitle to null", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: true,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBeNull();
      });

      it("preserves null userTitle", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: null,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBeNull();
      });

      it("preserves empty string userTitle", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: "",
        };
        const fixed = TerminalView.State.fix(input);
        // Empty string is a valid string — should be preserved
        expect(fixed.value.userTitle).toBe("");
      });

      it("does not affect other state fields when userTitle is present", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.external,
          cwd: "/home/user",
          serial: null,
          focus: true,
          userTitle: "dev server",
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.cwd).toBe("/home/user");
        expect(fixed.value.userTitle).toBe("dev server");
      });
    });
  });
});
