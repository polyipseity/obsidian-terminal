/**
 * Unit tests for `src/settings-manager.ts`: what reading settings in (Reload,
 * Import) keeps of the version of the built-in keymappings. The tests use the
 * manager of the real plugin class, so they also pin that the plugin uses it.
 */
import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPlugin } from "../../src/main.js";
import { EarlyPatchManager } from "../../src/patch.js";
import { Settings } from "../../src/settings-data.js";
import { TerminalSettingsManager } from "../../src/settings-manager.js";
import { tick } from "../support/helpers.js";

/*
 * The plugin's modules require the xterm.js addons through the `BUNDLE` map of
 * `src/imports.js` when they load. The ligatures addon cannot load in Node, and
 * nothing here uses it.
 */
vi.mock("../../src/imports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/imports.js")>();
  return {
    ...actual,
    BUNDLE: new Map([
      ...actual.BUNDLE,
      ["@xterm/addon-ligatures", (): unknown => ({})],
    ]),
  };
});

describe("TerminalSettingsManager", () => {
  // The built-in keymappings as a device on 3.29.0 saves them.
  const ignored = Settings.DEFAULT.keymappings.map((mapping) =>
    mapping.action === "sendToObsidian"
      ? { ...mapping, action: "ignore" }
      : mapping,
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Settings as data.json holds them, without a version when it is undefined.
  function saved(version?: number): unknown {
    const { keymappingDefaultsVersion: _version, ...rest } = Settings.DEFAULT,
      stored: unknown = JSON.parse(
        JSON.stringify({
          ...rest,
          keymappingDefaultsVersion: version,
          keymappings: ignored,
        }),
      );
    return stored;
  }

  // The plugin's manager, loaded from a data.json of this version. `data` is
  // what the reads of data.json after that return.
  async function loaded(...data: readonly unknown[]) {
    // The plugin patches the console and the window as it is constructed.
    vi.spyOn(EarlyPatchManager.prototype, "load").mockImplementation(() => {});
    const context = new TerminalPlugin(new App(), {
        author: "test",
        description: "test",
        id: "terminal-test",
        minAppVersion: "1.4.11",
        name: "Terminal test",
        version: "0.0.0",
      }),
      loadData = vi.fn().mockResolvedValueOnce(Settings.DEFAULT);
    for (const datum of data) {
      loadData.mockResolvedValueOnce(datum);
    }
    Object.assign(context, { loadData });
    const { settings } = context;
    vi.spyOn(settings, "write").mockResolvedValue();
    settings.load();
    await settings.onLoaded;
    await tick();
    expect(settings.value.keymappingDefaultsVersion).toBe(
      Settings.KEYMAPPING_DEFAULTS_VERSION,
    );
    return settings;
  }

  it("is the manager of the plugin's settings", async () => {
    expect(await loaded()).toBeInstanceOf(TerminalSettingsManager);
  });

  it("reads keymappings saved without a version without one", async () => {
    const settings = await loaded(),
      read = saved();
    await settings.read(() => read);
    expect(settings.value).not.toHaveProperty("keymappingDefaultsVersion");
    expect(settings.value).toStrictEqual(Settings.fix(read).value);
  });

  it("reads data.json without a version when given no reader", async () => {
    const settings = await loaded(saved());
    await settings.read();
    expect(settings.value).not.toHaveProperty("keymappingDefaultsVersion");
    expect(settings.value.keymappings).toStrictEqual(ignored);
  });

  it("keeps the version and the entries of settings read with one", async () => {
    // A user of this version who set the built-in keymappings to Ignore.
    const settings = await loaded(),
      read = saved(Settings.KEYMAPPING_DEFAULTS_VERSION);
    await settings.read(() => read);
    expect(settings.value).toStrictEqual(Settings.fix(read).value);
    expect(settings.value.keymappings).toStrictEqual(ignored);
  });
});
