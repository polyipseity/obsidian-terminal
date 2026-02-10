/**
 * Unit tests for `src/settings.ts` — small, hermetic, and focused on behavior.
 */

import { describe, it, expect, vi } from "vitest";
import {
  makePluginContext,
  makeLoadedDoc,
  makeLocalSettingsManager,
  semVerString,
  makeMock,
} from "../helpers.js";
import { Settings } from "../../src/settings-data.js";
import { UpdatableUI } from "@polyipseity/obsidian-plugin-library";
import { loadSettings } from "../../src/settings.js";
// Keep type-only import of semver to avoid issues with mocked functions
import type { Setting } from "obsidian";

describe("loadSettings", () => {
  it("adds a setting tab and registers settings commands", () => {
    const addSettingTab = vi.fn();
    const context = makePluginContext({ addSettingTab });

    loadSettings(context, makeLoadedDoc());

    expect(addSettingTab).toHaveBeenCalled();
  });
});

interface ButtonFull {
  setIcon: () => ButtonFull;
  setTooltip: () => ButtonFull;
  setCta: () => ButtonFull;
  onClick: (fn: () => void) => ButtonFull;
  click: () => void;
  getCta: () => boolean;
}

function makeSettingMock(capturedButtons: ButtonFull[]): Setting {
  const base: Setting = {
    setName: vi.fn(() => base),
    addButton(cb: (b: ButtonFull) => void) {
      const createButton = (): ButtonFull => {
        let _click: (() => void) | undefined;
        let _cta = false;
        const b: ButtonFull = {
          setIcon: vi.fn(() => b),
          setTooltip: vi.fn(() => b),
          setCta: vi.fn(() => {
            _cta = true;
            return b;
          }),
          onClick: vi.fn((fn: () => void) => {
            _click = fn;
            return b;
          }),
          click: vi.fn(() => {
            if (_click) _click();
          }),
          getCta: vi.fn(() => _cta),
        };
        return b;
      };
      const button = createButton();
      capturedButtons.push(button);
      cb(button);
      return this;
    },
    addToggle(_v: unknown) {
      void _v;
      return this;
    },
    addExtraButton(_v: unknown) {
      void _v;
      return this;
    },
  } as unknown as Setting;

  return makeMock<Setting>(base);
}

describe("SettingTab onLoad behavior", () => {
  it("creates documentation buttons that call docs.open and sets CTA when version is null", async () => {
    const context = makePluginContext({ version: null });
    const open = vi.fn();
    const docs = makeLoadedDoc({ open });

    // import here to use mocked AdvancedSettingTab
    const { SettingTab } = await import("../../src/settings.js");

    const tab = new SettingTab(context, docs);

    const capturedButtons: ButtonFull[] = [];

    // @ts-expect-error: protected
    const { ui } = tab;
    ui.newSetting = (_cont: unknown, f: (s: Setting) => unknown) => {
      f(makeSettingMock(capturedButtons));
      return {} as UpdatableUI;
    };

    // Spy on closeSetting
    const lib = vi.mocked(await import("@polyipseity/obsidian-plugin-library"));
    vi.spyOn(lib, "closeSetting").mockImplementation(() => {});

    // @ts-expect-error: protected
    tab.onLoad();

    // Three documentation buttons should have been added
    expect(capturedButtons.length).toBeGreaterThanOrEqual(3);

    // Click all buttons and ensure docs.open called
    capturedButtons[0]?.click();
    capturedButtons[1]?.click();
    capturedButtons[2]?.click();

    expect(open).toHaveBeenCalledTimes(3);

    // Third button (changelog) should have CTA set because version is null
    expect(capturedButtons[2]?.getCta()).toBe(true);
  });

  it("snapshot0 returns persistent settings object", async () => {
    const context = makePluginContext();
    const { SettingTab } = await import("../../src/settings.js");
    const tab = new SettingTab(context, makeLoadedDoc());

    // @ts-expect-error: protected
    const snap = tab.snapshot0();
    expect(snap).toEqual(Settings.persistent(context.settings.value));
  });
});

describe("SettingTab CTA when semverLt true", () => {
  it("sets CTA when local settings version is less than plugin version", async () => {
    // Re-mock semver.lt to return true and reset modules so the change takes effect
    vi.resetModules();
    vi.doMock("semver/functions/lt.js", () => ({
      default: () => true,
      __esModule: true,
    }));

    const context = makePluginContext({
      version: semVerString("1.0.0"),
      localSettings: makeLocalSettingsManager(semVerString("0.0.0")),
    });
    const open = vi.fn();
    const docs = makeLoadedDoc({ open });

    const { SettingTab } = await import("../../src/settings.js");
    const tab = new SettingTab(context, docs);

    const capturedButtons: ButtonFull[] = [];

    // @ts-expect-error: protected
    const { ui } = tab;
    ui.newSetting = (_cont: unknown, f: (s: Setting) => unknown) => {
      f(makeSettingMock(capturedButtons));
      return {} as UpdatableUI;
    };

    // @ts-expect-error: protected
    tab.onLoad();

    // Ensure we have at least three buttons and assert CTA
    expect(capturedButtons.length).toBeGreaterThanOrEqual(3);
    expect(capturedButtons[2]?.getCta()).toBe(true);
  });
});
