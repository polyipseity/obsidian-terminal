/**
 * Integration tests for `src/main.ts`: starts of the plugin over what an
 * earlier version saved, through the real `TerminalPlugin.onload` with its
 * real settings managers. A vault is one `data.json`; each device has its own
 * local storage. A device on 3.29.0 is played by what its fixers do to the
 * settings this version saves.
 */
import * as library from "@polyipseity/obsidian-plugin-library";
import {
  type Platform,
  StorageSettingsManager,
} from "@polyipseity/obsidian-plugin-library";
import { App, Component, FileSystemAdapter } from "obsidian";
import { isEqual } from "es-toolkit/predicate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPlugin } from "../../src/main.js";
import { EarlyPatchManager } from "../../src/patch.js";
import { deviceProfileEntries } from "../../src/profile-choice.js";
import { Settings } from "../../src/settings-data.js";
import * as profileProperties from "../../src/terminal/profile-properties.js";
import { TerminalView } from "../../src/terminal/view.js";
import released329 from "../fixtures/data-3.29.0.json" with { type: "json" };
import released328 from "../fixtures/data-3.28.0.json" with { type: "json" };
import { tick } from "../support/helpers.js";

const platform = vi.hoisted((): { current: Platform.All } => ({
  current: "darwin",
}));
// Every button a settings row or dialog made, newest last.
const buttons = vi.hoisted(
  (): { click: () => void; getTooltip: () => string }[] => [],
);
vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get CURRENT() {
        return platform.current;
      },
    },
  };
});
vi.mock("obsidian", async () => {
  // The shared mock has no base View; ItemView supplies its leaf contract here.
  const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
  // Rows of the settings tab, which draws as it loads, need their elements.
  class Setting extends actual.Setting {
    public readonly settingEl = document.createElement("div");
    public readonly nameEl = document.createElement("div");
    public readonly descEl = document.createElement("div");
    public readonly controlEl = document.createElement("div");
    public constructor(containerEl: HTMLElement) {
      super(containerEl);
      containerEl.append(this.settingEl);
    }
    public override addButton(
      configure: (button: InstanceType<typeof actual.ButtonComponent>) => void,
    ): this {
      const button = Object.assign(new actual.ButtonComponent(this.controlEl), {
        buttonEl: document.createElement("button"),
        removeCta: vi.fn(),
      });
      // The shared mock's button records its tooltip and clicks.
      buttons.push(button as unknown as (typeof buttons)[number]);
      configure(button);
      return this;
    }
    // The library redraws a row by the components each `add` made, so each
    // hands its configurator one, unlike the shared mock.
    public override addText(configure: (c: never) => void): this {
      configure(
        Object.assign(new actual.TextComponent(this.controlEl), {
          inputEl: document.createElement("input"),
        }) as never,
      );
      return this;
    }
    public override addTextArea(configure: (c: never) => void): this {
      configure(
        Object.assign(new actual.TextAreaComponent(this.controlEl), {
          inputEl: document.createElement("textarea"),
        }) as never,
      );
      return this;
    }
    public override addDropdown(configure: (c: never) => void): this {
      configure(
        Object.assign(new actual.DropdownComponent(this.controlEl), {
          selectEl: document.createElement("select"),
        }) as never,
      );
      return this;
    }
    public override addToggle(configure: (c: never) => void): this {
      configure(new actual.ToggleComponent(this.controlEl) as never);
      return this;
    }
    public override addExtraButton(configure: (c: never) => void): this {
      configure(new actual.ExtraButtonComponent(this.controlEl) as never);
      return this;
    }
    public override addSlider(configure: (c: never) => void): this {
      configure(new actual.SliderComponent(this.controlEl) as never);
      return this;
    }
  }
  // A notice times out through the window of its element.
  class Notice extends actual.Notice {
    public readonly noticeEl = document.createElement("div");
  }
  return { ...actual, Notice, Setting, View: actual.ItemView };
});
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

// A start waits for data.json, which the plugin saves at most every 2 s.
vi.setConfig({ testTimeout: 60_000 });

const APP_ID = "r3291-vault",
  ID = "terminal",
  STORE = `${APP_ID}.${ID}.settings`,
  // Windows sends 31 key repeats while a key is held for about 1.5 s.
  REPEATS = 31;

type Json = Record<string, unknown>;
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A vault: what its `data.json` holds. */
function vault(data: unknown = released329) {
  return { data: json(data) };
}

/** A device: its local storage, which holds the vault's local settings. */
function device(local: unknown = null) {
  const items = new Map<string, string>(),
    storage: Storage = {
      get length(): number {
        return items.size;
      },
      clear: (): void => {
        items.clear();
      },
      getItem: (name: string): string | null => items.get(name) ?? null,
      key: (index: number): string | null => [...items.keys()][index] ?? null,
      removeItem: (name: string): void => {
        items.delete(name);
      },
      setItem: (name: string, value: string): void => {
        items.set(name, value);
      },
    };
  if (local !== null) {
    items.set(STORE, JSON.stringify(local));
  }
  return {
    items,
    storage,
    local: (): Json => JSON.parse(items.get(STORE) ?? "null") as Json,
  };
}
type Vault = ReturnType<typeof vault>;
type Device = ReturnType<typeof device>;

// What 3.29.0 kept in local storage after an update from 3.28.0 that it found
// malformed: one recovery copy of that data.json.
const OLD_COPY = "settings.2026-09-30T08:00:00.000Z",
  local329 = {
    hasUsedIntegratedTerminal: true,
    lastReadChangelogVersion: "3.29.0",
    recovery: { [OLD_COPY]: JSON.stringify(released328, null, 2) },
  };

// The built-in keymappings of this version.
const WINDOWS_PALETTE = {
    action: "sendToObsidian",
    actionArg: null,
    alt: false,
    ctrl: true,
    key: "p",
    meta: false,
    platform: "win32",
    shift: false,
  } as const,
  MACOS_PALETTE = {
    ...WINDOWS_PALETTE,
    ctrl: false,
    meta: true,
    platform: "darwin",
  } as const;

interface Hotkey {
  readonly modifiers: readonly string[];
  readonly key: string;
}
interface Command {
  id: string;
  checkCallback?: (checking: boolean) => boolean;
  callback?: () => unknown;
  hotkeys?: readonly Hotkey[];
  repeatable?: boolean;
}
// `Mod` stays symbolic: the table and the pressed key are compiled alike.
function compile(modifiers: readonly string[]): string {
  return [...modifiers]
    .sort((left, right) => left.localeCompare(right))
    .join(",");
}
// Obsidian's `Mod` is Command on macOS and Ctrl elsewhere.
function toMod(modifier: string): string {
  return modifier === (platform.current === "darwin" ? "Meta" : "Ctrl")
    ? "Mod"
    : modifier;
}

/**
 * The hotkey table of Obsidian 1.14.4, as `view.spec.ts` models it: the user's
 * keys first, then the default keys of the commands the user did not rebind.
 */
class HotkeyTable {
  public defaultKeys: Record<string, readonly Hotkey[]> = {};
  public baked = false;
  public bakedHotkeys: readonly { modifiers: string; key: string }[] = [];
  public bakedIds: readonly string[] = [];
  readonly #customKeys = new Map<string, readonly Hotkey[]>();

  public get customKeys(): Record<string, readonly Hotkey[]> {
    return Object.fromEntries(this.#customKeys);
  }

  public addDefaultHotkeys(id: string, keys: readonly Hotkey[]): void {
    this.defaultKeys[id] = keys;
    this.baked = false;
  }

  public setHotkeys(id: string, keys: readonly Hotkey[]): void {
    this.#customKeys.set(id, keys);
    this.baked = false;
  }

  public removeHotkeys(id: string): void {
    this.#customKeys.delete(id);
    this.baked = false;
  }

  public bake(): void {
    if (this.baked) return;
    this.baked = true;
    const entries = [
      ...this.#customKeys,
      ...Object.entries(this.defaultKeys).filter(
        ([id]) => !this.#customKeys.has(id),
      ),
    ].flatMap(([id, keys]) => keys.map((key) => ({ id, key })));
    this.bakedIds = entries.map(({ id }) => id);
    this.bakedHotkeys = entries.map(({ key: { key, modifiers } }) => ({
      key,
      modifiers: compile(modifiers),
    }));
  }
}

// The focused scope is protected; a subclass hands it to the tests.
class ScopeView extends TerminalView {
  public static readonly scope = ScopeView.focusedScope;
}

const owners: Component[] = [];

afterEach(() => {
  buttons.length = 0;
  for (const owner of owners.splice(0)) owner.unload();
  platform.current = "darwin";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A start of this version on `dev` in `vlt`, through the real `onload`. It
 * waits until both stores have saved what the start changed.
 */
async function start(
  vlt: Vault,
  dev: Device,
  appId: () => string = () => APP_ID,
) {
  // The early patch wraps the console and the window; the start needs only
  // its logging switch and an empty log.
  const early: { load0: () => unknown } = Object.getPrototypeOf(
    new EarlyPatchManager(new App()),
  ) as EarlyPatchManager & { load0: () => unknown };
  vi.spyOn(early, "load0").mockReturnValue({
    enableLoggingPatch: vi.fn(),
    log: { history: [], logger: { listen: () => vi.fn() } },
    unpatch: vi.fn(),
  });
  vi.stubGlobal("localStorage", dev.storage);
  // Obsidian's global for the window in front.
  vi.stubGlobal("activeWindow", window);
  const app = new App(),
    hotkeys = new HotkeyTable(),
    registry = new Map<string, Command>(),
    // Obsidian runs the check with `false`, else the callback.
    executeCommand = vi.fn((command: Command): boolean => {
      if (command.checkCallback) return command.checkCallback(false);
      command.callback?.();
      return true;
    }),
    palette: Command = {
      callback: vi.fn(),
      hotkeys: [{ key: "p", modifiers: ["Mod"] }],
      id: "command-palette:open",
    };
  registry.set(palette.id, palette);
  hotkeys.addDefaultHotkeys(palette.id, palette.hotkeys ?? []);
  Object.defineProperty(app, "appId", { get: appId });
  Object.defineProperty(app.keymap, "constructor", {
    value: {
      isMatch: (
        hotkey: { modifiers: string; key: string },
        pressed: { modifiers: string; key: string },
      ): boolean =>
        hotkey.modifiers === pressed.modifiers && hotkey.key === pressed.key,
    },
  });
  Object.assign(app, {
    commands: {
      executeCommand,
      findCommand: (id: string): Command | undefined => registry.get(id),
    },
    hotkeyManager: hotkeys,
  });
  // The layout work (system path, Python check, ConPTY spare) is not tested.
  Object.assign(app.workspace, { onLayoutReady: vi.fn() });
  // A vault on disk, as on desktop: the root directory commands need it.
  Object.assign(app.vault, { adapter: new FileSystemAdapter() });
  const plugin = new TerminalPlugin(app, {
      author: "test",
      description: "test",
      id: ID,
      minAppVersion: "1.4.11",
      name: "Terminal",
      version: "3.29.1",
    }),
    // The mock `Plugin` is no `Component`; the app's plugin is one.
    owner = new Component();
  owner.load();
  owners.push(owner);
  Object.assign(plugin, {
    // Obsidian prefixes the id with the plugin's and hands the command back.
    addCommand: (command: Command): Command => {
      command.id = `${ID}:${command.id}`;
      registry.set(command.id, command);
      if (command.hotkeys?.length) {
        hotkeys.addDefaultHotkeys(command.id, command.hotkeys);
      }
      return command;
    },
    addChild: owner.addChild.bind(owner),
    register: owner.register.bind(owner),
    registerDomEvent: owner.registerDomEvent.bind(owner),
    registerEvent: owner.registerEvent.bind(owner),
    registerInterval: owner.registerInterval.bind(owner),
    removeChild: owner.removeChild.bind(owner),
    loadData: vi.fn(async () => Promise.resolve(json(vlt.data))),
    saveData: vi.fn(async (data: unknown) => {
      vlt.data = json(data);
      return Promise.resolve();
    }),
  });
  // The terminal registers one catch-all listener on its focused scope.
  const register = vi.spyOn(ScopeView.scope, "register"),
    settingsMutate = vi.spyOn(plugin.settings, "mutate"),
    localMutate = vi.spyOn(plugin.localSettings, "mutate");
  plugin.onload();
  // The terminal registers its opening commands last.
  await vi.waitFor(
    () => {
      expect(registry.has(`${ID}:open-terminal.integrated.root`)).toBe(true);
    },
    { timeout: 10_000 },
  );
  if (StorageSettingsManager.hasFailed(plugin.localSettings.value)) {
    // Nothing is saved to a store without a name.
    await vi.waitFor(
      () => {
        expect(vlt.data).toStrictEqual(json(plugin.settings.value));
      },
      { interval: 50, timeout: 10_000 },
    );
  } else {
    await settle(vlt, dev, plugin);
  }
  /** One key-down in the focused terminal, as Obsidian hands it to the scope. */
  const send = (
      modifiers: readonly string[],
      key: string,
      init: KeyboardEventInit = {},
    ): unknown => {
      const listener = register.mock.lastCall?.[2];
      if (!listener) throw new Error("Missing focused-scope listener");
      return listener(
        new KeyboardEvent("keydown", {
          altKey: modifiers.includes("Alt"),
          ctrlKey: modifiers.includes("Ctrl"),
          key,
          metaKey: modifiers.includes("Meta"),
          shiftKey: modifiers.includes("Shift"),
          ...init,
        }),
        { key, modifiers: compile(modifiers.map(toMod)), vkey: key },
      );
    },
    // The first key-down, then one per key repeat.
    hold = (modifiers: readonly string[], key: string): unknown[] => [
      send(modifiers, key),
      ...Array.from({ length: REPEATS }, () =>
        send(modifiers, key, { repeat: true }),
      ),
    ];
  return {
    command: (id: string): Command => {
      const found = registry.get(`${ID}:${id}`);
      if (!found) throw new Error(`No command ${id}`);
      return found;
    },
    executeCommand,
    hold,
    hotkeys,
    localMutate,
    palette,
    plugin,
    send,
    settingsMutate,
  };
}

/** Waits until both stores hold what the plugin has; data.json waits ≤ 2 s. */
async function settle(
  vlt: Vault,
  dev: Device,
  plugin: TerminalPlugin,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(vlt.data).toStrictEqual(json(plugin.settings.value));
      expect(dev.local()).toStrictEqual(json(plugin.localSettings.value));
    },
    { interval: 50, timeout: 10_000 },
  );
  for (let index = 0; index < 4; index++) await tick();
}

/**
 * What the fixers of 3.29.0 make of data this version saved: they drop the
 * keys they do not know and give an action they do not know the action
 * Ignore. As in the library 3.29.0 bundles (63fa7fb), data is valid only when
 * the fixer changed nothing.
 */
function fix3290(data: unknown): {
  readonly valid: boolean;
  readonly value: Json;
} {
  const {
      keymappingDefaultsVersion: _version,
      keymappings,
      ...rest
    } = json(data) as Json & { keymappings: Settings.Keymapping[] },
    value = {
      ...rest,
      keymappings: keymappings.map((mapping) =>
        mapping.action === "sendToObsidian"
          ? { ...mapping, action: "ignore", actionArg: null }
          : mapping,
      ),
    };
  return { valid: isEqual(data, value), value };
}
function fix3290Local(local: unknown): {
  readonly valid: boolean;
  readonly value: Json & { recovery: Record<string, string> };
} {
  const {
    defaultProfile: _default,
    profileOrder: _order,
    ...value
  } = json(local) as Json & { recovery: Record<string, string> };
  return { valid: isEqual(local, value), value };
}

/**
 * A start of 3.29.0 on `dev` in `vlt`, as the library 63fa7fb runs it: both
 * stores are read and fixed; a store the fixer changed is reported and a copy
 * of what was read goes into the local recovery; both are saved fixed.
 *
 * @returns the stores 3.29.0 reported as malformed
 */
function start3290(vlt: Vault, dev: Device, when: string): string[] {
  const reported: string[] = [],
    readLocal: unknown = dev.local(),
    local = fix3290Local(readLocal),
    settings = fix3290(vlt.data),
    localValue = json(local.value);
  if (readLocal !== null && !local.valid) {
    reported.push("local settings");
    localValue.recovery[`${StorageSettingsManager.RECOVERY_PREFIX}${when}`] =
      JSON.stringify(readLocal, null, 2);
  }
  if (vlt.data !== null && !settings.valid) {
    reported.push("settings");
    localValue.recovery[`settings.${when}`] = JSON.stringify(vlt.data, null, 2);
  }
  vlt.data = json(settings.value);
  dev.items.set(STORE, JSON.stringify(localValue));
  return reported;
}

/** The copies the Recover button of All settings highlights. */
function highlightedCopies(dev: Device): string[] {
  const { recovery } = dev.local() as { recovery: Record<string, string> };
  return Object.entries(recovery)
    .filter(([key]) => key.startsWith("settings."))
    .filter(([, copy]) => !Settings.fix(JSON.parse(copy)).valid)
    .map(([key]) => key);
}

function keymappings(vlt: Vault): readonly Settings.Keymapping[] {
  return (vlt.data as Settings).keymappings;
}

describe("Export settings to current file", () => {
  it("writes the settings into the note's properties", async () => {
    const vlt = vault(),
      dev = device(local329),
      { command, plugin } = await start(vlt, dev),
      { app } = plugin,
      file = { extension: "md", path: "note.md" },
      written: Json[] = [];
    Object.assign(app.workspace, { getActiveFile: vi.fn(() => file) });
    vi.spyOn(app.metadataCache, "getFileCache").mockReturnValue({});
    vi.spyOn(app.fileManager, "processFrontMatter").mockImplementation(
      (_file, fn) => {
        const fm: Json = {};
        fn(fm);
        written.push(fm);
        return Promise.resolve();
      },
    );
    command("export-settings.current-file").checkCallback?.(false);
    await vi.waitFor(() => {
      expect(written).toStrictEqual([plugin.settings.value]);
    });
  });
});

describe("the stand-in for a device on 3.29.0", () => {
  it("takes what 3.29.0 saved as it is", () => {
    expect(fix3290(released329)).toStrictEqual({
      valid: true,
      value: released329,
    });
    expect(fix3290Local(local329)).toStrictEqual({
      valid: true,
      value: local329,
    });
  });
});

describe("the first start of this version over what 3.29.0 saved", () => {
  it.each([
    ["darwin", "custom-integrated"],
    ["linux", "custom-integrated"],
    // The default of data.json does not run on Windows.
    ["win32", null],
  ] as const)(
    "keeps every setting, profile and recovery copy, takes over the default and the order, and adds the palette keys once on %s",
    async (os, expectedDefault) => {
      platform.current = os;
      const errors = vi.spyOn(console, "error"),
        vlt = vault(),
        dev = device(local329);
      await start(vlt, dev);

      expect(errors).not.toHaveBeenCalled();
      // data.json: everything as 3.29.0 saved it, plus the two palette keys
      // after the user's keymappings and the version that offered them.
      expect(vlt.data).toStrictEqual({
        ...released329,
        keymappingDefaultsVersion: 1,
        keymappings: [
          ...released329.keymappings,
          WINDOWS_PALETTE,
          MACOS_PALETTE,
        ],
      });
      expect(Object.keys((vlt.data as Json)["profiles"] as Json)).toStrictEqual(
        Object.keys(released329.profiles),
      );
      // This device: the default it used on 3.29.0 where it runs, the order of
      // data.json, and the recovery copies as they were.
      expect(dev.local()).toStrictEqual({
        ...local329,
        defaultProfile: expectedDefault,
        profileOrder: Object.keys(released329.profiles),
      });
      expect(highlightedCopies(dev)).toStrictEqual([]);
    },
  );

  it("starts from what 3.28.0 saved without a report and loses nothing either", async () => {
    const errors = vi.spyOn(console, "error"),
      vlt = vault(released328),
      dev = device({
        hasUsedIntegratedTerminal: true,
        lastReadChangelogVersion: "3.28.0",
        recovery: {},
      });
    await start(vlt, dev);

    expect(errors).not.toHaveBeenCalled();
    const fixed = Settings.fix(json(released328));
    expect(fixed.valid).toBe(true);
    expect(vlt.data).toStrictEqual({
      ...json(fixed.value),
      keymappingDefaultsVersion: 1,
      keymappings: [...released328.keymappings, WINDOWS_PALETTE, MACOS_PALETTE],
    });
    // Every value 3.28.0 saved is still there.
    const { keymappings: _keymappings, ...rest328 } = released328;
    expect(vlt.data).toMatchObject(rest328);
    expect(dev.local()).toMatchObject({
      defaultProfile: "darwinIntegratedDefault",
      profileOrder: Object.keys(released328.profiles),
    });
  });

  it("starts without a default and in the order of data.json on a device that joins the vault, as the README says, and leaves data.json's default to the devices on 3.29.0", async () => {
    const errors = vi.spyOn(console, "error"),
      vlt = vault(),
      dev = device(),
      { plugin } = await start(vlt, dev);

    expect(errors).not.toHaveBeenCalled();
    expect(dev.local()).toMatchObject({
      defaultProfile: null,
      profileOrder: [],
    });
    expect(deviceProfileEntries(plugin).map(([id]) => id)).toStrictEqual(
      Object.keys(released329.profiles),
    );
    expect((vlt.data as Json)["defaultProfile"]).toBe("custom-integrated");
    expect(keymappings(vlt).slice(-2)).toStrictEqual([
      WINDOWS_PALETTE,
      MACOS_PALETTE,
    ]);
  });

  it("changes nothing at the next start", async () => {
    const vlt = vault(),
      dev = device(local329);
    await start(vlt, dev);
    const data = json(vlt.data),
      local = dev.local(),
      errors = vi.spyOn(console, "error"),
      next = await start(vlt, dev);

    expect(errors).not.toHaveBeenCalled();
    expect(next.settingsMutate).not.toHaveBeenCalled();
    expect(next.localMutate).not.toHaveBeenCalled();
    expect(vlt.data).toStrictEqual(data);
    expect(dev.local()).toStrictEqual(local);
  });
});

describe("a start whose local store has no name", () => {
  it("uses the default of data.json for the session and keeps the store marked as not read, at every start", async () => {
    // Obsidian's private `appId` gone: the library cannot name the store.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {}),
      vlt = vault(),
      dev = device(local329),
      noName = (): string => {
        throw new Error("appId");
      };
    let malformed = "";
    for (let round = 0; round < 2; round++) {
      const { plugin } = await start(vlt, dev, noName);
      malformed = plugin.language.value.t("errors.malformed-data");
      // The changelog check after the takeover skips such a store.
      expect(StorageSettingsManager.hasFailed(plugin.localSettings.value)).toBe(
        true,
      );
      expect(plugin.localSettings.value.defaultProfile).toBe(
        "custom-integrated",
      );
      expect(dev.local()).toStrictEqual(local329);
    }
    expect(errors.mock.calls.some(([first]) => first === malformed)).toBe(
      false,
    );
  });
});

describe("a vault shared with a device still on 3.29.0", () => {
  it("keeps the user's keymappings first, one of each palette key, this device's choice and every profile through starts in turn", async () => {
    const vlt = vault(),
      mine = device(local329),
      other = device(local329);
    // This device chooses its own default and order.
    const order = [
      "custom-external",
      ...Object.keys(released329.profiles).filter(
        (id) => id !== "custom-external",
      ),
    ];
    {
      const { plugin } = await start(vlt, mine);
      await plugin.localSettings.mutate((local) => {
        local.defaultProfile =
          "preset-zshIntegrated" as Settings.DefaultProfile;
        local.profileOrder = order;
      });
      await plugin.localSettings.write();
    }
    const reports: string[][] = [];
    for (let round = 0; round < 3; round++) {
      reports.push(
        start3290(vlt, other, `2026-10-2${String(round)}T00:00:00.000Z`),
      );
      // 3.29.0 keeps the palette keys as Ignore and drops the version.
      expect(keymappings(vlt).slice(-2)).toStrictEqual([
        { ...WINDOWS_PALETTE, action: "ignore" },
        { ...MACOS_PALETTE, action: "ignore" },
      ]);
      expect(vlt.data).not.toHaveProperty("keymappingDefaultsVersion");

      const errors = vi.spyOn(console, "error");
      await start(vlt, mine);
      expect(errors).not.toHaveBeenCalled();
      expect(keymappings(vlt)).toStrictEqual([
        ...released329.keymappings,
        WINDOWS_PALETTE,
        MACOS_PALETTE,
      ]);
      expect((vlt.data as Json)["profiles"]).toStrictEqual(
        released329.profiles,
      );
      expect((vlt.data as Json)["defaultProfile"]).toBe("custom-integrated");
      expect(mine.local()).toMatchObject({
        defaultProfile: "preset-zshIntegrated",
        profileOrder: order,
      });
      expect(highlightedCopies(mine)).toStrictEqual([]);
    }
    // The device on 3.29.0 reports data.json at each start after this device
    // wrote it, as the release notes say; its own settings stay.
    expect(reports).toStrictEqual([["settings"], ["settings"], ["settings"]]);
    expect(fix3290(vlt.data).value["defaultProfile"]).toBe("custom-integrated");

    // The other device updates too: its copies of data.json from this
    // version are not malformed any more, and it keeps its own default.
    const errors = vi.spyOn(console, "error"),
      before = json(keymappings(vlt));
    await start(vlt, other);
    expect(errors).not.toHaveBeenCalled();
    expect(highlightedCopies(other)).toStrictEqual([]);
    expect(Object.keys((other.local()["recovery"] ?? {}) as Json)).toHaveLength(
      4,
    );
    expect(other.local()).toMatchObject({
      defaultProfile: "custom-integrated",
    });
    expect(keymappings(vlt)).toStrictEqual(before);
    expect(mine.local()).toMatchObject({
      defaultProfile: "preset-zshIntegrated",
    });
  });
});

describe("a palette key deleted while a device on 3.29.0 shares the vault", () => {
  it("comes back at each start of this version after that device saved data.json, and stays deleted otherwise", async () => {
    const vlt = vault(),
      mine = device(local329),
      other = device(local329);
    for (let round = 0; round < 2; round++) {
      {
        const { plugin } = await start(vlt, mine);
        // Settings → Keymappings: the user deletes Ctrl+P → Send to Obsidian.
        await plugin.settings.mutate((settings) => {
          settings.keymappings = settings.keymappings.filter(
            ({ action, platform: os }) =>
              action !== "sendToObsidian" || os !== "win32",
          );
        });
        await plugin.settings.write();
        await settle(vlt, mine, plugin);
      }
      await start(vlt, mine);
      expect(keymappings(vlt).filter(({ key }) => key === "p")).toStrictEqual([
        MACOS_PALETTE,
      ]);

      start3290(vlt, other, `2026-10-2${String(round)}T00:00:00.000Z`);
      await start(vlt, mine);
      // The deleted key is offered again, after the macOS one.
      expect(keymappings(vlt).filter(({ key }) => key === "p")).toStrictEqual([
        MACOS_PALETTE,
        WINDOWS_PALETTE,
      ]);
    }
  });
});

describe("going back to 3.29.0 and forward again on one device", () => {
  it("reports once on 3.29.0, keeps everything synced, and back on this version takes the default of data.json again", async () => {
    const vlt = vault(),
      dev = device(local329);
    {
      const { plugin } = await start(vlt, dev);
      await plugin.localSettings.mutate((local) => {
        local.defaultProfile =
          "preset-zshIntegrated" as Settings.DefaultProfile;
      });
      await plugin.localSettings.write();
    }
    // 3.29.0 drops what it does not know in both stores and keeps copies.
    expect(start3290(vlt, dev, "2026-10-25T00:00:00.000Z")).toStrictEqual([
      "local settings",
      "settings",
    ]);
    // On 3.29.0 the default is the one data.json had before the update.
    expect(fix3290(vlt.data).value["defaultProfile"]).toBe("custom-integrated");

    const errors = vi.spyOn(console, "error");
    await start(vlt, dev);
    expect(errors).not.toHaveBeenCalled();
    expect(keymappings(vlt).slice(-2)).toStrictEqual([
      WINDOWS_PALETTE,
      MACOS_PALETTE,
    ]);
    // The README says to choose the default again after going back.
    expect(dev.local()).toMatchObject({ defaultProfile: "custom-integrated" });
    expect(highlightedCopies(dev)).toStrictEqual([]);
  });
});

describe("keys in a focused terminal after the first start", () => {
  // A user of 3.29.0 with key interception and Add to command on.
  const intercepting = (): Vault =>
    vault({
      ...released329,
      addToCommand: true,
      interceptKeysWhenFocused: true,
    });

  it.each([
    ["win32", ["Ctrl"]],
    ["darwin", ["Meta"]],
  ] as const)(
    "opens the command palette once from a held palette key on %s and lets nothing reach the shell",
    async (os, modifiers) => {
      platform.current = os;
      const { executeCommand, hold, palette } = await start(
        intercepting(),
        device(local329),
      );

      expect(hold(modifiers, "p")).toStrictEqual(
        Array<unknown>(REPEATS + 1).fill(false),
      );
      expect(executeCommand).toHaveBeenCalledExactlyOnceWith(palette);
    },
  );

  it("turns a Ctrl+P → Ignore the user made on 3.29.0 into the palette key in its place, as the release notes accept, and opens the palette from it", async () => {
    platform.current = "win32";
    const own = { ...WINDOWS_PALETTE, action: "ignore" },
      vlt = vault({
        ...released329,
        addToCommand: true,
        interceptKeysWhenFocused: true,
        keymappings: [own, ...released329.keymappings],
      }),
      { executeCommand, hold, palette } = await start(vlt, device(local329));

    // Indistinguishable from what 3.29.0 saves for the palette key.
    expect(keymappings(vlt)).toStrictEqual([
      WINDOWS_PALETTE,
      ...released329.keymappings,
      MACOS_PALETTE,
    ]);
    expect(hold(["Ctrl"], "p")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(false),
    );
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(palette);
  });

  it("keeps a Ctrl+P of the user's own on every platform, adds only Cmd+P, and never opens the palette from Ctrl+P", async () => {
    platform.current = "win32";
    const own = {
        ...WINDOWS_PALETTE,
        action: "sendText",
        actionArg: "\u0010",
        platform: null,
      },
      vlt = vault({
        ...released329,
        addToCommand: true,
        interceptKeysWhenFocused: true,
        keymappings: [...released329.keymappings, own],
      }),
      errors = vi.spyOn(console, "error"),
      { executeCommand, hold } = await start(vlt, device(local329));

    expect(errors).not.toHaveBeenCalled();
    expect(keymappings(vlt)).toStrictEqual([
      ...released329.keymappings,
      own,
      MACOS_PALETTE,
    ]);
    // Left to the terminal, which runs the user's keymapping.
    expect(hold(["Ctrl"], "p")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(undefined),
    );
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+P to the shell on Linux", async () => {
    platform.current = "linux";
    const { executeCommand, send } = await start(
      intercepting(),
      device(local329),
    );

    expect(send(["Ctrl"], "p")).toBeUndefined();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("opens this device's default once from a held Mod+Shift+H, and leaves the key to the shell after Add to command is turned off", async () => {
    const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue(),
      { hold, plugin, send } = await start(intercepting(), device(local329));

    expect(hold(["Meta", "Shift"], "H")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(false),
    );
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledOnce();
    });
    expect(spawn.mock.calls[0]?.[1].profile).toStrictEqual(
      released329.profiles["custom-integrated"],
    );

    await plugin.settings.mutate((settings) => {
      settings.addToCommand = false;
    });
    expect(send(["Meta", "Shift"], "H")).toBeUndefined();
    expect(send(["Meta", "Shift"], "H", { repeat: true })).toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("opens this device's default from Mod+Shift+H, not the default of data.json", async () => {
    const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue(),
      { hold } = await start(
        intercepting(),
        device({ ...local329, defaultProfile: "preset-zshIntegrated" }),
      );

    expect(hold(["Meta", "Shift"], "H")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(false),
    );
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledOnce();
    });
    expect(spawn.mock.calls[0]?.[1].profile).toStrictEqual(
      released329.profiles["preset-zshIntegrated"],
    );
  });

  it("opens the first integrated profile that runs on Windows in this device's order from Ctrl+Shift+H, where the default of data.json does not run", async () => {
    platform.current = "win32";
    const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue(),
      dev = device(local329),
      { hold, plugin } = await start(intercepting(), dev);
    expect(dev.local()).toMatchObject({ defaultProfile: null });

    expect(hold(["Ctrl", "Shift"], "H")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(false),
    );
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledOnce();
    });
    expect(spawn.mock.calls[0]?.[1].profile).toStrictEqual(
      released329.profiles.win32IntegratedDefault,
    );

    // Profiles → this device moves Git Bash to the top.
    await plugin.localSettings.mutate((local) => {
      local.profileOrder = ["preset-gitBashIntegrated"];
    });
    expect(hold(["Ctrl", "Shift"], "H")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(false),
    );
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });
    expect(spawn.mock.calls[1]?.[1].profile).toStrictEqual(
      released329.profiles["preset-gitBashIntegrated"],
    );
  });

  it("leaves Mod+Shift+H and its repeats to the shell with Add to command off as 3.29.0 saved it, and opens once after it is turned on", async () => {
    const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue(),
      { hold, plugin } = await start(
        vault({ ...released329, interceptKeysWhenFocused: true }),
        device(local329),
      );

    expect(hold(["Meta", "Shift"], "H")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(undefined),
    );
    expect(spawn).not.toHaveBeenCalled();

    await plugin.settings.mutate((settings) => {
      settings.addToCommand = true;
    });
    expect(hold(["Meta", "Shift"], "H")).toStrictEqual(
      Array<unknown>(REPEATS + 1).fill(false),
    );
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledOnce();
    });
  });

  it("opens the first external profile in this device's order from a hotkey the user gave the External command, without a tab", async () => {
    // The notice that names the program.
    const notice = vi.spyOn(library, "notice2"),
      open = vi.spyOn(profileProperties, "openProfile").mockResolvedValue(null),
      dev = device({
        ...local329,
        defaultProfile: "custom-integrated",
        profileOrder: ["preset-iTerm2External"],
      }),
      { hotkeys, plugin, send } = await start(intercepting(), dev),
      getLeaf = vi.spyOn(plugin.app.workspace, "getLeaf");
    hotkeys.setHotkeys(`${ID}:open-terminal.external.root`, [
      { key: "j", modifiers: ["Mod", "Shift"] },
    ]);

    expect(send(["Meta", "Shift"], "j")).toBe(false);
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledOnce();
    });
    expect(open.mock.calls[0]?.[1]).toStrictEqual(
      released329.profiles["preset-iTerm2External"],
    );
    expect(getLeaf).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();
  });
});

describe("settings that a device on 3.29.0 rewrote, read in again", () => {
  // What a device on 3.29.0 saved after this version offered the palette
  // keys: the keys as Ignore and no version.
  function rewritten(): unknown {
    const vlt = vault({
      ...released329,
      keymappingDefaultsVersion: 1,
      keymappings: [...released329.keymappings, WINDOWS_PALETTE, MACOS_PALETTE],
    });
    start3290(vlt, device(local329), "2026-10-25T00:00:00.000Z");
    return vlt.data;
  }

  it("offers the palette keys again at the next start after Reload", async () => {
    const vlt = vault(),
      dev = device(local329),
      { plugin } = await start(vlt, dev);
    vlt.data = rewritten();
    // All settings → Reload.
    await plugin.settings.read();
    await plugin.settings.write();
    await settle(vlt, dev, plugin);

    await start(vlt, dev);
    expect(keymappings(vlt).slice(-2)).toStrictEqual([
      WINDOWS_PALETTE,
      MACOS_PALETTE,
    ]);
  });

  it("offers the palette keys again at the next start after Import settings from clipboard", async () => {
    const vlt = vault(),
      dev = device(local329),
      { command, plugin } = await start(vlt, dev),
      pasted = rewritten();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue(JSON.stringify(pasted)) },
    });
    command("import-settings.clipboard").callback?.();
    await vi.waitFor(() => {
      expect(plugin.settings.value.keymappings.slice(-2)).toStrictEqual([
        { ...WINDOWS_PALETTE, action: "ignore" },
        { ...MACOS_PALETTE, action: "ignore" },
      ]);
    });
    await settle(vlt, dev, plugin);

    await start(vlt, dev);
    expect(keymappings(vlt).slice(-2)).toStrictEqual([
      WINDOWS_PALETTE,
      MACOS_PALETTE,
    ]);
  });

  it("offers the palette keys again at the next start after an import in the data editor of All settings", async () => {
    const vlt = vault(),
      dev = device(local329),
      { plugin } = await start(vlt, dev),
      { t } = plugin.language.value,
      pasted = rewritten();
    expect(Settings.fix(pasted).valid).toBe(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue(JSON.stringify(pasted)) },
    });
    // The newest button with this tooltip, or the one right before `next`.
    const press = (tooltip: string, next?: string): void => {
      const button = buttons.findLast(
        (b, index) =>
          b.getTooltip() === tooltip &&
          (next === void 0 || buttons[index + 1]?.getTooltip() === next),
      );
      if (!button) throw new Error(`No button ${tooltip}`);
      button.click();
    };
    // Settings → All settings → Edit (the row's first button, before
    // Recover) → Import from clipboard.
    press(
      t("settings.all-settings-actions.edit"),
      t("settings.all-settings-actions.recover"),
    );
    const errors = vi.spyOn(console, "error");
    press(t("components.edit-data.import-from-clipboard"));
    await vi.waitFor(() => {
      expect(plugin.settings.value.keymappings.slice(-2)).toStrictEqual([
        { ...WINDOWS_PALETTE, action: "ignore" },
        { ...MACOS_PALETTE, action: "ignore" },
      ]);
    });
    await settle(vlt, dev, plugin);
    // The import was valid: no report and no recovery copy.
    expect(errors).not.toHaveBeenCalled();
    expect(dev.local()["recovery"]).toStrictEqual(local329.recovery);

    await start(vlt, dev);
    expect(keymappings(vlt).slice(-2)).toStrictEqual([
      WINDOWS_PALETTE,
      MACOS_PALETTE,
    ]);
  });
});
