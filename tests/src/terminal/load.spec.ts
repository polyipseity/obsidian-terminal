import { isDeepStrictEqual } from "node:util";
import {
  Platform,
  SettingsManager,
  addCommand,
  addRibbonIcon,
  createI18n,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import { isEqual } from "es-toolkit/predicate";
import { FileSystemAdapter, Menu } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginLocales } from "../../../assets/locales.js";
import {
  pythonSettingsContext,
  withPythonSpare,
} from "../../fixtures/python-settings-ui.js";
import { bezelIconId, tileIconId } from "../../../src/icons.js";
import { LocalSettings, Settings } from "../../../src/settings-data.js";
import { TerminalSettingsManager } from "../../../src/settings-manager.js";
import { loadTerminal } from "../../../src/terminal/load.js";
import { CONPTY_HOST_POOL } from "../../../src/terminal/pseudoterminal.js";
import {
  SelectProfileModal,
  spawnTerminal,
} from "../../../src/terminal/spawn.js";
import { TerminalView } from "../../../src/terminal/view.js";
import {
  type Win32PythonSpawn,
  checkWindowsPython,
  clearWindowsPythonDiagnoses,
  invalidateWindowsPythonDiagnosis,
  runPluginPythonCheck,
} from "../../../src/terminal/win32-doctor.js";

import {
  getSystemPathGeneration,
  warmSystemPath,
} from "../../../src/terminal/environment.js";
import { tick } from "../../support/helpers.js";

const ribbonMenu = vi.hoisted(() => {
  class Item {
    public readonly setTitle = vi.fn((_title: string) => this);
    public readonly onClick = vi.fn((_callback: () => void) => this);
  }
  const items: (Item | null)[] = [];
  return { Item, items, showAtMouseEvent: vi.fn(), openSelector: vi.fn() };
});

// The shared Obsidian mock declares `TFile` as an interface only; the loader
// narrows with `instanceof TFile`, which needs a class at run time.
const obsidianClasses = vi.hoisted(() => ({
  TFile: class TFile {
    public readonly parent: unknown = null;
    public readonly path: string = "";
  },
}));

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  FileSystemAdapter: vi.fn(),
  MarkdownView: vi.fn(),
  TFolder: vi.fn(),
  TFile: obsidianClasses.TFile,
  Menu: vi.fn(
    class {
      public readonly showAtMouseEvent = ribbonMenu.showAtMouseEvent;
      public readonly addItem = (
        configure: (item: InstanceType<typeof ribbonMenu.Item>) => unknown,
      ): this => {
        const item = new ribbonMenu.Item();
        configure(item);
        ribbonMenu.items.push(item);
        return this;
      };
      public readonly addSeparator = (): this => {
        ribbonMenu.items.push(null);
        return this;
      };
    },
  ),
}));
vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return {
    ...actual,
    Platform: { ...actual.Platform, CURRENT: "win32" },
    addCommand: vi.fn(),
    addRibbonIcon: vi.fn<typeof addRibbonIcon>(
      (_context, _id, _icon, _title, callback) => {
        const create = (): HTMLElement => {
          const element = document.createElement("div");
          element.addEventListener("click", callback);
          element.addEventListener("auxclick", callback);
          return element;
        };
        // Match the library's getter: reload replaces the current element.
        let element = create();
        document.body.append(element);
        return {
          get elementRef(): HTMLElement {
            return element;
          },
          reload: vi.fn(() => {
            const replacement = create();
            element.replaceWith(replacement);
            element = replacement;
          }),
        };
      },
    ),
    notice2: vi.fn(),
  };
});

vi.mock("../../../src/terminal/spawn.js", () => ({
  SelectProfileModal: vi.fn(
    class {
      public readonly open = ribbonMenu.openSelector;
    },
  ),
  spawnTerminal: vi.fn(),
}));

vi.mock("../../../src/terminal/view.js", () => ({
  TerminalView: {
    allowWhileFocused: vi.fn(),
    load: vi.fn(),
    reloadFocusedHotkeys: vi.fn(),
  },
}));
vi.mock("../../../src/terminal/environment.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/terminal/environment.js")
  >()),
  warmSystemPath: vi.fn(),
}));
vi.mock("../../../src/terminal/win32-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/terminal/win32-doctor.js")
  >()),
  checkWindowsPython: vi.fn(),
  runPluginPythonCheck: vi.fn(),
}));

const ensureSpare = vi.fn<(typeof CONPTY_HOST_POOL)["ensureSpare"]>();

const domCleanup: (() => void)[] = [];

async function terminalContext(initial: unknown = {}) {
  const context = await pythonSettingsContext(initial);
  // The default profile a test names is the one this device chose.
  await context.localSettings.mutate((local) => {
    local.defaultProfile = context.settings.value.defaultProfile;
  });
  // The shared Python fixture has no DOM lifecycle; exercise real bubbling here.
  Object.assign(context, {
    registerDomEvent: vi.fn(
      (
        target: Document,
        type: "contextmenu",
        callback: (event: MouseEvent) => unknown,
      ) => {
        target.addEventListener(type, callback);
        const dispose = (): void => {
          target.removeEventListener(type, callback);
        };
        context.register(dispose);
        domCleanup.push(dispose);
      },
    ),
  });
  return context;
}

afterEach(() => {
  for (const dispose of domCleanup.splice(0)) dispose();
  document.body.replaceChildren();
  ribbonMenu.items.length = 0;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("terminal ribbon profile access", () => {
  async function ribbon(
    defaultProfile: string | null = "integrated",
    tabStatus: Settings.TabStatus = Settings.DEFAULT.tabStatus,
  ) {
    const context = await terminalContext({
      defaultProfile,
      tabStatus,
      profiles: {
        integrated: {
          ...Settings.Profile.DEFAULTS.integrated,
          name: "Integrated shell",
          platforms: { win32: true },
        },
        external: {
          ...Settings.Profile.DEFAULTS.external,
          name: "External & shell",
          platforms: { win32: true },
        },
        incompatible: {
          ...Settings.Profile.DEFAULTS.external,
          platforms: { darwin: true },
        },
        console: Settings.Profile.DEFAULTS.developerConsole,
      },
    });
    Object.assign(context.language, {
      value: await createI18n(
        PluginLocales.RESOURCES,
        PluginLocales.FORMATTERS,
        {
          lng: "en",
          fallbackLng: "en",
        },
      ),
    });
    Object.assign(context.app.vault, {
      adapter: Object.assign(new FileSystemAdapter(), {
        getBasePath: vi.fn().mockReturnValue("C:\\Vault"),
      }),
    });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    loadTerminal(context);
    const result = vi.mocked(addRibbonIcon).mock.results.at(-1);
    if (result?.type !== "return")
      throw new Error("Ribbon icon was not registered");
    return { context, icon: result.value };
  }

  function rightClick(target: EventTarget): MouseEvent {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    target.dispatchEvent(event);
    return event;
  }

  it("gives the ribbon button the tile icon, the terminal in lines alone, whatever Program status says", async () => {
    for (const tabStatus of Settings.TAB_STATUSES) {
      const { context } = await ribbon("integrated", tabStatus);
      expect(context.settings.value.tabStatus).toBe(tabStatus);
      const icon = vi.mocked(addRibbonIcon).mock.calls.at(-1)?.[2];
      expect(icon, tabStatus).toBe(tileIconId(context));
      // `<plugin id>:tab-tile`; this context has no manifest to name the id.
      expect(icon, tabStatus).toMatch(/:tab-tile$/u);
      // Not the icon with the marks, nor the plain one it had before.
      expect(icon).not.toBe(bezelIconId(context));
      expect(icon).not.toBe("terminal-square");
    }
  });

  it("lists compatible profiles and opens an external profile in the vault root", async () => {
    const { context, icon } = await ribbon();
    const event = rightClick(icon.elementRef);
    expect(event.defaultPrevented).toBe(true);
    expect(Menu).toHaveBeenCalledTimes(1);
    expect(ribbonMenu.showAtMouseEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(
      ribbonMenu.items.map((item) => item?.setTitle.mock.calls[0]?.[0] ?? null),
    ).toEqual([
      "Integrated: Integrated shell (integrated)",
      "External: External & shell (external)",
      "Developer console: console (console)",
      null,
      "Open in terminal: Select",
    ]);
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(SelectProfileModal).not.toHaveBeenCalled();
    ribbonMenu.items[1]?.onClick.mock.calls[0]?.[0]();
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles.external,
      { cwd: "C:\\Vault", profileSourceId: "external" },
    );
    ribbonMenu.items.at(-1)?.onClick.mock.calls[0]?.[0]();
    expect(SelectProfileModal).toHaveBeenCalledExactlyOnceWith(
      context,
      "C:\\Vault",
    );
    expect(ribbonMenu.openSelector).toHaveBeenCalledTimes(1);
  });

  it("shows only the selector without a separator when no profile is compatible", async () => {
    const { context, icon } = await ribbon();
    await context.settings.mutate((settings) => {
      delete settings.profiles.integrated;
      delete settings.profiles.external;
      delete settings.profiles.console;
    });
    const event = rightClick(icon.elementRef);
    expect(ribbonMenu.showAtMouseEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(
      ribbonMenu.items.map((item) => item?.setTitle.mock.calls[0]?.[0] ?? null),
    ).toEqual(["Open in terminal: Select"]);
  });

  it("ignores a Ctrl-click context menu without preventing default", async () => {
    const { icon } = await ribbon();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    icon.elementRef.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(Menu).not.toHaveBeenCalled();
    expect(ribbonMenu.showAtMouseEvent).not.toHaveBeenCalled();
  });

  it("shows one menu from a ribbon descendant after repeated reloads", async () => {
    const { context, icon } = await ribbon();
    const original = icon.elementRef;
    // Default-profile edits invoke the registered reload; language changes
    // invoke the same library reload and replace the element again.
    for (const [accessor, callback] of vi.mocked(context.localSettings).onMutate
      .mock.calls) {
      const previous = accessor(context.localSettings.value);
      const next = accessor(
        LocalSettings.fix({
          ...context.localSettings.value,
          defaultProfile: null,
        }).value,
      );
      if (previous !== next && typeof previous === "string")
        await callback(next, previous, context.localSettings.value);
    }
    expect(icon.elementRef).not.toBe(original);
    icon.reload();
    const child = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.elementRef.append(child);
    const event = rightClick(child);
    expect(event.defaultPrevented).toBe(true);
    expect(Menu).toHaveBeenCalledTimes(1);
    expect(ribbonMenu.showAtMouseEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(ribbonMenu.items).toHaveLength(5);
    // A stale element (even reattached) and unrelated targets are ignored.
    document.body.append(original);
    expect(rightClick(original).defaultPrevented).toBe(false);
    expect(rightClick(document.body).defaultPrevented).toBe(false);
    expect(Menu).toHaveBeenCalledTimes(1);
    for (const [dispose] of vi.mocked(context).register.mock.calls) dispose();
    expect(rightClick(child).defaultPrevented).toBe(false);
    expect(Menu).toHaveBeenCalledTimes(1);
  });

  describe.each(["integrated", null])(
    "default profile: %s",
    (defaultProfile) => {
      it.each(["plain", "Ctrl", "Cmd"])(
        "preserves %s-click behaviour",
        async (modifier) => {
          const { context, icon } = await ribbon(defaultProfile);
          icon.elementRef.dispatchEvent(
            new MouseEvent("click", {
              button: 0,
              ctrlKey: modifier === "Ctrl",
              metaKey: modifier === "Cmd",
            }),
          );
          if (defaultProfile && modifier === "plain") {
            expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
              context,
              context.settings.value.profiles.integrated,
              { cwd: "C:\\Vault", profileSourceId: "integrated" },
            );
            expect(SelectProfileModal).not.toHaveBeenCalled();
          } else {
            expect(SelectProfileModal).toHaveBeenCalledExactlyOnceWith(
              context,
              "C:\\Vault",
            );
            expect(ribbonMenu.openSelector).toHaveBeenCalledTimes(1);
            expect(spawnTerminal).not.toHaveBeenCalled();
          }
          expect(notice2).toHaveBeenCalledTimes(
            !defaultProfile && modifier === "plain" ? 1 : 0,
          );
          expect(Menu).not.toHaveBeenCalled();
        },
      );

      it.each(["plain", "Ctrl", "Cmd"])(
        "ignores %s right-button auxclick without opening a profile or selector",
        async (modifier) => {
          const { icon } = await ribbon(defaultProfile);
          rightClick(icon.elementRef);
          icon.elementRef.dispatchEvent(
            new MouseEvent("auxclick", {
              button: 2,
              ctrlKey: modifier === "Ctrl",
              metaKey: modifier === "Cmd",
            }),
          );
          expect(spawnTerminal).not.toHaveBeenCalled();
          expect(SelectProfileModal).not.toHaveBeenCalled();
          expect(notice2).not.toHaveBeenCalled();
          expect(Menu).toHaveBeenCalledTimes(1);
        },
      );
    },
  );
});

describe("commands and menu items of one profile type", () => {
  afterEach(() => {
    vi.mocked(addCommand).mockReset();
  });

  const integrated = {
      ...Settings.Profile.DEFAULTS.integrated,
      platforms: { win32: true },
    },
    external = {
      ...Settings.Profile.DEFAULTS.external,
      platforms: { win32: true },
    },
    developerConsole = Settings.Profile.DEFAULTS.developerConsole;

  /** A listener of the workspace's file-menu or editor-menu event. */
  type MenuListener = (menu: unknown, target: unknown, info?: unknown) => void;

  async function load(initial: unknown) {
    vi.mocked(addCommand).mockImplementation((_context, name, command) => ({
      ...command,
      name: name(),
    }));
    const context = await terminalContext(initial),
      fileMenus: MenuListener[] = [],
      editorMenus: MenuListener[] = [];
    Object.assign(context.language, {
      value: await createI18n(
        PluginLocales.RESOURCES,
        PluginLocales.FORMATTERS,
        { lng: "en", fallbackLng: "en" },
      ),
    });
    Object.assign(context.app.vault, {
      adapter: Object.assign(new FileSystemAdapter(), {
        getBasePath: vi.fn().mockReturnValue("C:\\Vault"),
        getFullPath: vi.fn((path: string) => `C:\\Vault\\${path}`),
      }),
    });
    Object.assign(context.app.workspace, {
      onLayoutReady: vi.fn(),
      on: vi.fn((name: string, callback: MenuListener) => {
        if (name === "file-menu") fileMenus.push(callback);
        if (name === "editor-menu") editorMenus.push(callback);
        return {};
      }),
    });
    loadTerminal(context);
    const commands = vi
      .mocked(addCommand)
      .mock.calls.map(([, , command]) => command);
    function run(id: string, checking = false): unknown {
      const command = commands.find((command0) => command0.id === id);
      if (!command?.checkCallback) throw new Error(`No command: ${id}`);
      return command.checkCallback(checking);
    }
    // Shows a menu to `listeners`; its items are clicked by title.
    function openMenu(
      listeners: readonly MenuListener[],
      target: unknown,
      info?: unknown,
    ): { readonly titles: readonly string[]; click: (title: string) => void } {
      const items = new Map<string, () => void>(),
        menu = {
          addSeparator: vi.fn(),
          addItem(configure: (item: unknown) => void): void {
            const record = { title: "", click: (): void => {} },
              item = {
                setTitle(value: string): unknown {
                  record.title = value;
                  return item;
                },
                setIcon(): unknown {
                  return item;
                },
                onClick(value: () => void): unknown {
                  record.click = value;
                  return item;
                },
              };
            configure(item);
            items.set(record.title, record.click);
          },
        };
      for (const listener of listeners) listener(menu, target, info);
      return {
        titles: [...items.keys()],
        click(title: string): void {
          const click = items.get(title);
          if (!click) throw new Error(`No menu item: ${title}`);
          click();
        },
      };
    }
    // Right-clicks a note in the folder "Notes" and chooses the item titled so.
    function clickFolderMenuItem(title: string): void {
      openMenu(fileMenus, { parent: { path: "Notes" } }).click(title);
    }
    return {
      clickFolderMenuItem,
      commands,
      context,
      // Right-clicks `file` in the file explorer.
      openFileMenu: (file: unknown) => openMenu(fileMenus, file),
      // Right-clicks in an editor that shows `info`.
      openEditorMenu: (info: unknown) => openMenu(editorMenus, {}, info),
      run,
    };
  }

  /** Runs `body` as if this device ran on `platform`. */
  async function onPlatform<T>(
    platform: Platform.All,
    body: () => Promise<T>,
  ): Promise<T> {
    const previous = Platform.CURRENT;
    Object.assign(Platform, { CURRENT: platform });
    try {
      return await body();
    } finally {
      Object.assign(Platform, { CURRENT: previous });
    }
  }

  it("opens the default profile from a command of its type", async () => {
    const { context, run } = await load({
      defaultProfile: "chosen",
      profiles: {
        first: integrated,
        chosen: { ...integrated, name: "Chosen" },
      },
    });
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["chosen"],
      { cwd: "C:\\Vault", profileSourceId: "chosen" },
    );
  });

  it("opens the default profile from a menu item of its type", async () => {
    const { clickFolderMenuItem, context } = await load({
      defaultProfile: "chosen",
      profiles: {
        first: integrated,
        chosen: { ...integrated, name: "Chosen" },
      },
    });
    clickFolderMenuItem("Open in terminal: Integrated");
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["chosen"],
      { cwd: "C:\\Vault\\Notes", profileSourceId: "chosen" },
    );
  });

  it("opens the first profile of the type when the default has another type", async () => {
    const { context, run } = await load({
      defaultProfile: "outside",
      profiles: {
        outside: external,
        first: integrated,
        second: { ...integrated, name: "Second" },
      },
    });
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["first"],
      { cwd: "C:\\Vault", profileSourceId: "first" },
    );
  });

  it("opens the first compatible profile of the type when the default does not run on this platform", async () => {
    const { context, run } = await load({
      defaultProfile: "chosen",
      profiles: {
        chosen: { ...integrated, platforms: { darwin: true } },
        first: integrated,
      },
    });
    expect(context.settings.value.defaultProfile).toBe("chosen");
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["first"],
      { cwd: "C:\\Vault", profileSourceId: "first" },
    );
  });

  it("opens the first profile of the type when the default profile is gone", async () => {
    const { context, run } = await load({
      profiles: {
        first: integrated,
        second: { ...integrated, name: "Second" },
      },
    });
    // This device's default can name a profile deleted on another device.
    Object.assign(context.localSettings, {
      value: { ...context.localSettings.value, defaultProfile: "gone" },
    });
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["first"],
      { cwd: "C:\\Vault", profileSourceId: "first" },
    );
  });

  it("only reports the command as available while checking", async () => {
    const { run } = await load({
      defaultProfile: "chosen",
      profiles: {
        first: integrated,
        chosen: { ...integrated, name: "Chosen" },
      },
    });
    expect(run("open-terminal.integrated.root", true)).toBe(true);
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(notice2).not.toHaveBeenCalled();
  });

  it.each([
    ["second", "second"],
    ["chosen", "first"],
  ])(
    "lets the external commands follow the same rule (default %s opens %s)",
    async (defaultProfile, opened) => {
      const { context, run } = await load({
        defaultProfile,
        profiles: {
          first: external,
          second: { ...external, name: "Second" },
          chosen: integrated,
        },
      });
      expect(run("open-terminal.external.root")).toBe(true);
      expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
        context,
        context.settings.value.profiles[opened],
        { cwd: "C:\\Vault", profileSourceId: opened },
      );
    },
  );

  it("opens the default profile from the command that carries Mod+Shift+H", async () => {
    const { commands, context } = await load({
        defaultProfile: "chosen",
        profiles: {
          first: integrated,
          chosen: { ...integrated, name: "Chosen" },
        },
      }),
      withKey = commands.filter((command) =>
        command.hotkeys?.some(
          ({ key, modifiers }) =>
            key === "H" && modifiers.join("+") === "Mod+Shift",
        ),
      );
    expect(withKey.map(({ id }) => id)).toEqual([
      "open-terminal.integrated.current",
    ]);
    // Holding the keys opens one terminal: Obsidian repeats only repeatable commands.
    expect(withKey[0]?.repeatable ?? false).toBe(false);
    expect(withKey[0]?.checkCallback?.(false)).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["chosen"],
      { cwd: "C:\\Vault", profileSourceId: "chosen" },
    );
  });

  it("opens the default profile in the folder of the file viewed last", async () => {
    const { commands, context } = await load({
        defaultProfile: "chosen",
        profiles: {
          first: integrated,
          chosen: { ...integrated, name: "Chosen" },
        },
      }),
      alpha = Object.assign(new obsidianClasses.TFile(), {
        parent: { path: "Projects/alpha" },
        path: "Projects/alpha/note.md",
      });
    Object.assign(context.app.workspace, {
      getLastOpenFiles: vi.fn().mockReturnValue([alpha.path]),
    });
    Object.assign(context.app.vault, {
      getAbstractFileByPath: vi.fn((path: string) =>
        path === alpha.path ? alpha : null,
      ),
    });
    const withKey = commands.find((command) =>
      command.hotkeys?.some(
        ({ key, modifiers }) =>
          key === "H" && modifiers.join("+") === "Mod+Shift",
      ),
    );
    expect(withKey?.checkCallback?.(false)).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["chosen"],
      { cwd: "C:\\Vault\\Projects/alpha", profileSourceId: "chosen" },
    );
  });

  it("opens the default profile in the folder of the active file", async () => {
    const { context, run } = await load({
      defaultProfile: "chosen",
      profiles: {
        first: integrated,
        chosen: { ...integrated, name: "Chosen" },
      },
    });
    Object.assign(context.app.workspace, {
      getActiveFile: vi.fn().mockReturnValue({ parent: { path: "Notes" } }),
    });
    expect(run("open-terminal.integrated.current")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["chosen"],
      { cwd: "C:\\Vault\\Notes", profileSourceId: "chosen" },
    );
  });

  it("opens the default profile from an editor menu item of its type", async () => {
    const { context, openEditorMenu } = await load({
      defaultProfile: "chosen",
      profiles: {
        first: integrated,
        chosen: { ...integrated, name: "Chosen" },
      },
    });
    openEditorMenu({ file: { parent: { path: "Notes" } } }).click(
      "Open in terminal: Integrated",
    );
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["chosen"],
      { cwd: "C:\\Vault\\Notes", profileSourceId: "chosen" },
    );
  });

  it("opens from each item of a folder menu the profile its type opens", async () => {
    const { context, openFileMenu } = await load({
        defaultProfile: "chosen",
        profiles: {
          outside: external,
          first: integrated,
          chosen: { ...integrated, name: "Chosen" },
        },
      }),
      { profiles } = context.settings.value,
      cwd = "C:\\Vault\\Notes",
      menu = openFileMenu({ parent: { path: "Notes" } });
    expect(menu.titles).toEqual([
      "Open in terminal: Default",
      "Open in terminal: External",
      "Open in terminal: Integrated",
      "Open in terminal: Select",
    ]);
    for (const title of menu.titles) menu.click(title);
    expect(vi.mocked(spawnTerminal).mock.calls).toEqual([
      [context, profiles["chosen"], { cwd, profileSourceId: "chosen" }],
      [context, profiles["outside"], { cwd, profileSourceId: "outside" }],
      [context, profiles["chosen"], { cwd, profileSourceId: "chosen" }],
    ]);
    expect(SelectProfileModal).toHaveBeenCalledExactlyOnceWith(context, cwd);
  });

  it.each([
    [
      "deleted",
      ({ chosen: _chosen, ...profiles }: Settings.Profiles) => profiles,
    ],
    [
      "given another type",
      (profiles: Settings.Profiles) => ({
        ...profiles,
        chosen: { ...external, name: "Chosen" },
      }),
    ],
    [
      "moved to another platform",
      (profiles: Settings.Profiles) => ({
        ...profiles,
        chosen: { ...integrated, name: "Chosen", platforms: { darwin: true } },
      }),
    ],
  ])(
    "opens the first profile of the type once the default profile is %s, also from a menu opened before",
    async (_case, change) => {
      const { context, openFileMenu, run } = await load({
          defaultProfile: "chosen",
          profiles: {
            first: integrated,
            chosen: { ...integrated, name: "Chosen" },
          },
        }),
        { chosen } = context.settings.value.profiles,
        menu = openFileMenu({ parent: { path: "Notes" } });
      expect(run("open-terminal.integrated.root")).toBe(true);
      await context.settings.mutate((settingsM) => {
        Object.assign(settingsM, {
          profiles: change(context.settings.value.profiles),
        });
      });
      menu.click("Open in terminal: Integrated");
      expect(run("open-terminal.integrated.root")).toBe(true);
      const { first } = context.settings.value.profiles;
      expect(vi.mocked(spawnTerminal).mock.calls).toEqual([
        [context, chosen, { cwd: "C:\\Vault", profileSourceId: "chosen" }],
        [context, first, { cwd: "C:\\Vault\\Notes", profileSourceId: "first" }],
        [context, first, { cwd: "C:\\Vault", profileSourceId: "first" }],
      ]);
    },
  );

  it.each([
    ["chosen", "first", "second"],
    ["first", "chosen", "second"],
    ["first", "second", "chosen"],
  ])(
    "opens the default profile wherever the list holds it (%s, %s, %s)",
    async (...order) => {
      const { context, run } = await load({
        defaultProfile: "chosen",
        profiles: Object.fromEntries(
          order.map((id) => [id, { ...integrated, name: id }]),
        ),
      });
      expect(run("open-terminal.integrated.root")).toBe(true);
      expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
        context,
        context.settings.value.profiles["chosen"],
        { cwd: "C:\\Vault", profileSourceId: "chosen" },
      );
    },
  );

  it.each([
    ["chosen", "chosen"],
    [null, "2"],
  ])(
    "opens %s as the default with integer-like ids listed first, else %s",
    async (defaultProfile, opened) => {
      const { context, run } = await load({
        defaultProfile,
        profiles: {
          chosen: { ...integrated, name: "Chosen" },
          "10": integrated,
          "2": integrated,
        },
      });
      expect(Object.keys(context.settings.value.profiles)).toEqual([
        "2",
        "10",
        "chosen",
      ]);
      expect(run("open-terminal.integrated.root")).toBe(true);
      expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
        context,
        context.settings.value.profiles[opened],
        { cwd: "C:\\Vault", profileSourceId: opened },
      );
    },
  );

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "opens the first profile of the type when the default profile id %s names no stored profile",
    async (defaultProfile) => {
      const { context, run } = await load({
        defaultProfile,
        profiles: {
          first: integrated,
          second: { ...integrated, name: "Second" },
        },
      });
      expect(run("open-terminal.integrated.root")).toBe(true);
      expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
        context,
        context.settings.value.profiles["first"],
        { cwd: "C:\\Vault", profileSourceId: "first" },
      );
    },
  );

  it("opens a default profile stored under the id __proto__", async () => {
    // As JSON.parse reads data.json: an own property, not the prototype.
    const initial: unknown = JSON.parse(
        `{"defaultProfile":"__proto__","profiles":{"first":${JSON.stringify(
          integrated,
        )},"__proto__":${JSON.stringify({ ...integrated, name: "Proto" })}}}`,
      ),
      { context, run } = await load(initial),
      { profiles } = context.settings.value;
    expect(Object.keys(profiles)).toEqual(["first", "__proto__"]);
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      Object.getOwnPropertyDescriptor(profiles, "__proto__")?.value,
      { cwd: "C:\\Vault", profileSourceId: "__proto__" },
    );
  });

  it.each([
    ["an unknown type", { type: "remote", platforms: { win32: true } }],
    ["no type", { ...Settings.Profile.DEFAULTS[""], name: "Empty" }],
  ])(
    "opens the first profile of each type when the default profile has %s",
    async (_case, chosen) => {
      const { context, run } = await load({
          defaultProfile: "chosen",
          profiles: { chosen, first: integrated, console: developerConsole },
        }),
        { profiles } = context.settings.value;
      expect(run("open-terminal.integrated.root")).toBe(true);
      expect(run("open-terminal.developerConsole")).toBe(true);
      expect(vi.mocked(spawnTerminal).mock.calls).toEqual([
        [
          context,
          profiles["first"],
          { cwd: "C:\\Vault", profileSourceId: "first" },
        ],
        [context, profiles["console"], { profileSourceId: "console" }],
      ]);
    },
  );

  it.each(
    Platform.DESKTOP.flatMap((platform) => [
      [platform, "here", "here"],
      [platform, "elsewhere", "everywhere"],
    ]),
  )(
    "on %s, with the default profile %s, opens %s from a command of its type",
    async (platform, defaultProfile, opened) => {
      await onPlatform(platform, async () => {
        const others = Platform.DESKTOP.filter((other) => other !== platform),
          { context, run } = await load({
            defaultProfile,
            profiles: {
              everywhere: {
                ...integrated,
                platforms: { darwin: true, linux: true, win32: true },
              },
              here: { ...integrated, platforms: { [platform]: true } },
              elsewhere: {
                ...integrated,
                platforms: Object.fromEntries(
                  others.map((other) => [other, true]),
                ),
              },
            },
          });
        expect(run("open-terminal.integrated.root")).toBe(true);
        expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
          context,
          context.settings.value.profiles[opened],
          { cwd: "C:\\Vault", profileSourceId: opened },
        );
      });
    },
  );

  it.each(Platform.ALL)(
    "on %s opens a developer console default from the developer console command",
    async (platform) => {
      await onPlatform(platform, async () => {
        const { context, run } = await load({
          defaultProfile: "chosen",
          profiles: {
            first: developerConsole,
            here: { ...integrated, platforms: { [platform]: true } },
            chosen: { ...developerConsole, name: "Chosen" },
          },
        });
        expect(run("open-terminal.developerConsole")).toBe(true);
        expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
          context,
          context.settings.value.profiles["chosen"],
          { cwd: undefined, profileSourceId: "chosen" },
        );
      });
    },
  );

  it("opens nothing from a command while Add to command is off", async () => {
    const { run } = await load({
      addToCommand: false,
      defaultProfile: "chosen",
      profiles: {
        first: integrated,
        chosen: { ...integrated, name: "Chosen" },
      },
    });
    expect(run("open-terminal.integrated.root", true)).toBe(false);
    expect(run("open-terminal.integrated.root")).toBe(false);
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(notice2).not.toHaveBeenCalled();
  });

  it("reports the command as available while checking with no profile of the type", async () => {
    const { run } = await load({ profiles: { outside: external } });
    expect(run("open-terminal.integrated.root", true)).toBe(true);
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(notice2).not.toHaveBeenCalled();
  });

  it("opens the default profile of a data.json read back from text and leaves it alone", async () => {
    // The presets plus a profile marked as default, as data.json holds them.
    const saved = JSON.stringify({
        ...Settings.DEFAULT,
        defaultProfile: "pwsh",
        profiles: {
          ...Settings.DEFAULT.profiles,
          pwsh: { ...integrated, executable: "pwsh", name: "PowerShell 7" },
        },
      }),
      data: unknown = JSON.parse(saved);
    expect(Settings.fix(data).valid).toBe(true);
    const { context, run } = await load(data),
      loaded = context.settings.value,
      writes = vi.mocked(context.settings).write.mock.calls.length;
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(run("open-terminal.integrated.root", true)).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      loaded.profiles["pwsh"],
      { cwd: "C:\\Vault", profileSourceId: "pwsh" },
    );
    // The 3.29.0 rule would have opened the preset, the first integrated one.
    expect(
      Settings.Profile.defaultEntryOfType(
        "integrated",
        loaded.profiles,
        "win32",
      )?.[0],
    ).toBe("win32IntegratedDefault");
    // Opening reads the settings only.
    expect(context.settings.value).toBe(loaded);
    expect(vi.mocked(context.settings).write.mock.calls).toHaveLength(writes);
  });

  it("opens a developer console default from the developer console command", async () => {
    const { context, run } = await load({
      defaultProfile: "chosen",
      profiles: {
        first: developerConsole,
        chosen: { ...developerConsole, name: "Chosen" },
      },
    });
    expect(run("open-terminal.developerConsole")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["chosen"],
      { cwd: undefined, profileSourceId: "chosen" },
    );
  });

  it("keeps the notice when no profile has the type", async () => {
    const { context, run } = await load({
      defaultProfile: "outside",
      profiles: { outside: external },
    });
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(notice2).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      context.settings.value.noticeTimeout,
      context,
    );
    expect(vi.mocked(notice2).mock.calls[0]?.[0]()).toBe(
      "No default profile for type 'Integrated'",
    );
  });
});

describe("profiles as this device chose them", () => {
  afterEach(() => {
    vi.mocked(addCommand).mockReset();
  });

  const integrated = {
      ...Settings.Profile.DEFAULTS.integrated,
      platforms: { win32: true },
    },
    // data.json, whose default another device chose; this device runs Windows.
    synced = {
      defaultProfile: "first",
      profiles: {
        first: { ...integrated, name: "First" },
        second: { ...integrated, name: "Second" },
        mac: {
          ...Settings.Profile.DEFAULTS.integrated,
          name: "Mac",
          platforms: { darwin: true },
        },
      },
    };

  // What each listener saw when it last ran, which the managers keep for it.
  // Keyed by accessor: listeners may share a callback.
  const seen = new Map<unknown, unknown>();

  /** Loads the plugin with this device's store `local`. */
  async function load(local: unknown) {
    vi.mocked(addCommand).mockImplementation((_context, name, command) => ({
      ...command,
      name: name(),
    }));
    const context = await terminalContext(synced);
    Object.assign(context.localSettings, {
      value: LocalSettings.fix(local).value,
    });
    Object.assign(context.language, {
      value: await createI18n(
        PluginLocales.RESOURCES,
        PluginLocales.FORMATTERS,
        { lng: "en", fallbackLng: "en" },
      ),
    });
    Object.assign(context.app.vault, {
      adapter: Object.assign(new FileSystemAdapter(), {
        getBasePath: vi.fn().mockReturnValue("C:\\Vault"),
      }),
    });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    loadTerminal(context);
    seen.clear();
    for (const [accessor] of vi.mocked(context.settings).onMutate.mock.calls)
      seen.set(accessor, accessor(context.settings.value));
    for (const [accessor] of vi.mocked(context.localSettings).onMutate.mock
      .calls)
      seen.set(accessor, accessor(context.localSettings.value));
    const ribbon = vi.mocked(addRibbonIcon).mock.results.at(-1),
      title = vi.mocked(addRibbonIcon).mock.calls.at(-1)?.[3];
    if (ribbon?.type !== "return" || !title)
      throw new Error("Ribbon icon was not registered");
    const commands = vi
      .mocked(addCommand)
      .mock.calls.map(([, , command]) => command);
    return {
      context,
      icon: ribbon.value,
      title,
      run: (id: string): unknown => {
        const command = commands.find((command0) => command0.id === id);
        if (!command?.checkCallback) throw new Error(`No command: ${id}`);
        return command.checkCallback(false);
      },
    };
  }

  /**
   * Runs the listeners of `store` whose part changed since they last ran, as
   * the managers do.
   */
  async function mutate<T>(
    store: {
      value: T;
      readonly onMutate: (
        accessor: (value: T) => unknown,
        callback: (cur: unknown, prev: unknown, value: T) => unknown,
      ) => unknown;
    },
    value: T,
  ): Promise<void> {
    store.value = value;
    for (const [accessor, callback] of vi.mocked(store.onMutate).mock.calls) {
      const before = seen.get(accessor),
        after = accessor(value);
      seen.set(accessor, after);
      if (!isEqual(before, after)) await callback(after, before, value);
    }
  }

  it("opens this device's default from the ribbon, not the one in data.json", async () => {
    const { context, icon, title } = await load({ defaultProfile: "second" });
    expect(title()).toBe("Open terminal: Second");
    icon.elementRef.dispatchEvent(new MouseEvent("click", { button: 0 }));
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["second"],
      { cwd: "C:\\Vault", profileSourceId: "second" },
    );
    expect(SelectProfileModal).not.toHaveBeenCalled();
  });

  it.each([
    ["a store that 3.29.0 wrote", { lastReadChangelogVersion: "0.0.0" }],
    ["an inherited property", { defaultProfile: "constructor" }],
    ["a profile deleted on another device", { defaultProfile: "gone" }],
    ["a profile that does not run here", { defaultProfile: "mac" }],
  ])(
    "shows the profile selector from the ribbon for %s",
    async (_case, local) => {
      const { icon, title } = await load(local);
      expect(title()).toBe("Open terminal");
      icon.elementRef.dispatchEvent(new MouseEvent("click", { button: 0 }));
      expect(spawnTerminal).not.toHaveBeenCalled();
      expect(SelectProfileModal).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "C:\\Vault",
      );
    },
  );

  it("lists the ribbon menu in this device's order", async () => {
    const { icon } = await load({
      profileOrder: ["second", "mac", "constructor", "first"],
    });
    icon.elementRef.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }),
    );
    expect(
      ribbonMenu.items.map((item) => item?.setTitle.mock.calls[0]?.[0] ?? null),
    ).toEqual([
      "Integrated: Second (second)",
      "Integrated: First (first)",
      null,
      "Open in terminal: Select",
    ]);
  });

  it("opens this device's default from a command of its type", async () => {
    const { context, run } = await load({ defaultProfile: "second" });
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["second"],
      { cwd: "C:\\Vault", profileSourceId: "second" },
    );
  });

  it("opens the first profile of a type in this device's order", async () => {
    const { context, run } = await load({
      defaultProfile: null,
      profileOrder: ["mac", "second", "first"],
    });
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["second"],
      { cwd: "C:\\Vault", profileSourceId: "second" },
    );
  });

  it("redraws the ribbon button when this device's default changes, not data.json's", async () => {
    const { context, icon } = await load({ defaultProfile: "second" });
    await mutate(
      context.settings,
      Settings.fix({ ...context.settings.value, defaultProfile: null }).value,
    );
    expect(icon.reload).not.toHaveBeenCalled();
    await mutate(
      context.localSettings,
      LocalSettings.fix({
        ...context.localSettings.value,
        defaultProfile: "first",
      }).value,
    );
    expect(icon.reload).toHaveBeenCalledTimes(1);
  });

  it("redraws the ribbon button when data.json loses the profile of this device's default", async () => {
    const { context, icon, title } = await load({ defaultProfile: "second" });
    expect(title()).toBe("Open terminal: Second");
    // Import settings, or Reload or Edit under All settings, with data.json
    // from a device that deleted the profile.
    await mutate(
      context.settings,
      Settings.fix({
        ...context.settings.value,
        profiles: Object.fromEntries(
          Object.entries(context.settings.value.profiles).filter(
            ([id]) => id !== "second",
          ),
        ),
      }).value,
    );
    expect(title()).toBe("Open terminal");
    expect(icon.reload).toHaveBeenCalledTimes(1);
  });

  it("redraws the ribbon button when the profile of this device's default is renamed", async () => {
    const { context, icon, title } = await load({ defaultProfile: "second" });
    await mutate(
      context.settings,
      Settings.fix({
        ...context.settings.value,
        profiles: {
          ...context.settings.value.profiles,
          second: { ...synced.profiles.second, name: "Renamed" },
        },
      }).value,
    );
    expect(title()).toBe("Open terminal: Renamed");
    expect(icon.reload).toHaveBeenCalledTimes(1);
  });

  it("redraws the ribbon button when data.json gives this device's new default the name shown before", async () => {
    const { context, icon, title } = await load({ defaultProfile: "second" });
    await mutate(
      context.localSettings,
      LocalSettings.fix({
        ...context.localSettings.value,
        defaultProfile: "first",
      }).value,
    );
    expect(icon.reload).toHaveBeenCalledTimes(1);
    // Edit under All settings, or Import, renames the new default.
    await mutate(
      context.settings,
      Settings.fix({
        ...context.settings.value,
        profiles: {
          ...context.settings.value.profiles,
          first: { ...synced.profiles.first, name: "Second" },
        },
      }).value,
    );
    expect(title()).toBe("Open terminal: Second");
    expect(icon.reload).toHaveBeenCalledTimes(2);
  });

  it("redraws the ribbon button when this device's new default has the name shown before data.json renamed the old one", async () => {
    const { context, icon, title } = await load({ defaultProfile: "second" });
    await mutate(
      context.settings,
      Settings.fix({
        ...context.settings.value,
        profiles: {
          ...context.settings.value.profiles,
          first: { ...synced.profiles.first, name: "Second" },
          second: { ...synced.profiles.second, name: "Renamed" },
        },
      }).value,
    );
    expect(icon.reload).toHaveBeenCalledTimes(1);
    await mutate(
      context.localSettings,
      LocalSettings.fix({
        ...context.localSettings.value,
        defaultProfile: "first",
      }).value,
    );
    expect(title()).toBe("Open terminal: Second");
    expect(icon.reload).toHaveBeenCalledTimes(2);
  });

  it("redraws the ribbon button once when data.json changes after this device's default", async () => {
    const { context, icon } = await load({ defaultProfile: "second" });
    await mutate(
      context.localSettings,
      LocalSettings.fix({
        ...context.localSettings.value,
        defaultProfile: "first",
      }).value,
    );
    // Another profile changes; the name the ribbon shows stays.
    await mutate(
      context.settings,
      Settings.fix({
        ...context.settings.value,
        profiles: {
          ...context.settings.value.profiles,
          second: { ...synced.profiles.second, name: "Renamed" },
        },
      }).value,
    );
    expect(icon.reload).toHaveBeenCalledTimes(1);
  });

  it("opens this device's default from the default command, not the one in data.json", async () => {
    const { context, run } = await load({ defaultProfile: "second" });
    expect(run("open-terminal.default.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["second"],
      { cwd: "C:\\Vault", profileSourceId: "second" },
    );
    expect(notice2).not.toHaveBeenCalled();
  });

  it("opens the first profile of a type in this device's order when this device's default does not run here", async () => {
    const { context, run } = await load({
      defaultProfile: "mac",
      profileOrder: ["mac", "second", "first"],
    });
    expect(run("open-terminal.integrated.root")).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles["second"],
      { cwd: "C:\\Vault", profileSourceId: "second" },
    );
  });
});

describe("opening commands while a terminal has focus", () => {
  afterEach(() => {
    vi.mocked(addCommand).mockReset();
  });

  it("keeps every opening command and the developer console", async () => {
    // The loader passes on what `addCommand` returns; the bare mock returns nothing.
    vi.mocked(addCommand).mockImplementation((_context, name, command) => ({
      ...command,
      name: name(),
    }));
    const context = await terminalContext();
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });

    loadTerminal(context);

    const registered = vi
        .mocked(addCommand)
        .mock.calls.map(([, , { id }]) => id),
      allowed = vi
        .mocked(TerminalView)
        .allowWhileFocused.mock.calls.map(([{ id }]) => id);
    expect(allowed).toEqual(registered);
    expect(allowed).toEqual([
      "open-terminal.developerConsole",
      "open-terminal.default.root",
      "open-terminal.default.current",
      "open-terminal.external.root",
      "open-terminal.external.current",
      "open-terminal.integrated.root",
      "open-terminal.integrated.current",
      "open-terminal.select.root",
      "open-terminal.select.current",
    ]);
  });

  interface CommandsSetup {
    readonly activeFile?: { readonly parent: { readonly path: string } } | null;
    readonly fileSystem?: boolean;
    /** `file-open` events after loading, oldest first; `null` is no file. */
    readonly opened?: readonly (MockFile | null)[];
    /** `getLastOpenFiles`, newest first. */
    readonly lastOpenFiles?: readonly string[];
    /** The files `getAbstractFileByPath` still finds. */
    readonly files?: readonly MockFile[];
  }

  async function loadCommands({
    activeFile = null,
    fileSystem = true,
    opened = [],
    lastOpenFiles = [],
    files = [],
  }: CommandsSetup = {}) {
    vi.mocked(addCommand).mockImplementation((_context, name, command) => ({
      ...command,
      name: name(),
    }));
    const context = await terminalContext({
      defaultProfile: "integrated",
      profiles: {
        integrated: {
          ...Settings.Profile.DEFAULTS.integrated,
          platforms: { win32: true },
        },
      },
    });
    Object.assign(context.language, {
      value: await createI18n(
        PluginLocales.RESOURCES,
        PluginLocales.FORMATTERS,
        { lng: "en", fallbackLng: "en" },
      ),
    });
    Object.assign(context.app.vault, {
      adapter: fileSystem
        ? Object.assign(new FileSystemAdapter(), {
            getBasePath: vi.fn().mockReturnValue("C:\\Vault"),
            getFullPath: vi.fn((path: string) => `C:\\Vault\\${path}`),
          })
        : {},
      getAbstractFileByPath: vi.fn(
        (path: string) => files.find((file) => file.path === path) ?? null,
      ),
    });
    Object.assign(context.app.workspace, {
      getActiveFile: vi.fn().mockReturnValue(activeFile),
      getLastOpenFiles: vi.fn().mockReturnValue(lastOpenFiles),
      onLayoutReady: vi.fn(),
    });
    const registerEvent = vi.spyOn(context, "registerEvent");
    loadTerminal(context);
    const refs = registerEvent.mock.calls.map(([ref]) => ref);
    for (const file of opened) context.app.workspace.trigger("file-open", file);
    const commands = vi
      .mocked(addCommand)
      .mock.calls.map(([, , command]) => command);
    function run(id: string, checking: boolean): unknown {
      const command = commands.find((command0) => command0.id === id);
      if (!command?.checkCallback) throw new Error(`No command: ${id}`);
      return command.checkCallback(checking);
    }
    return { commands, context, refs, run };
  }

  type MockFile = InstanceType<typeof obsidianClasses.TFile>;

  function fileIn(folder: string, name = "note.md"): MockFile {
    return Object.assign(new obsidianClasses.TFile(), {
      parent: { path: folder },
      path: `${folder}/${name}`,
    });
  }

  function expectSpawnIn(
    context: Awaited<ReturnType<typeof loadCommands>>["context"],
    cwd: string,
  ): void {
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith(
      context,
      context.settings.value.profiles.integrated,
      { cwd, profileSourceId: "integrated" },
    );
    expect(notice2).not.toHaveBeenCalled();
  }

  it("binds Mod+Shift+H to the integrated current-directory command only", async () => {
    const { commands } = await loadCommands();
    expect(
      commands.filter((command) => "hotkeys" in command).map(({ id }) => id),
    ).toEqual(["open-terminal.integrated.current"]);
    expect(
      commands.find(({ id }) => id === "open-terminal.integrated.current")
        ?.hotkeys,
    ).toEqual([{ key: "H", modifiers: ["Mod", "Shift"] }]);
    expect(
      commands.find(({ id }) => id === "open-terminal.integrated.root"),
    ).not.toHaveProperty("hotkeys");
  });

  it("opens the vault root when the integrated current-directory command finds no file", async () => {
    const { context, run } = await loadCommands();
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault");
  });

  it("offers the vault root to the select current-directory command without any file", async () => {
    const { context, run } = await loadCommands();
    expect(run("open-terminal.select.current", false)).toBe(true);
    expect(SelectProfileModal).toHaveBeenCalledExactlyOnceWith(
      context,
      "C:\\Vault",
    );
    expect(notice2).not.toHaveBeenCalled();
  });

  it("offers a current-directory command without any file, silently", async () => {
    const { run } = await loadCommands();
    expect(run("open-terminal.integrated.current", true)).toBe(true);
    expect(notice2).not.toHaveBeenCalled();
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it("offers a current-directory command after a file was active, silently", async () => {
    const alpha = fileIn("Projects/alpha");
    const { run } = await loadCommands({
      files: [alpha],
      opened: [alpha, null],
    });
    expect(run("open-terminal.integrated.current", true)).toBe(true);
    expect(notice2).not.toHaveBeenCalled();
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it("stops following files once the plugin's events are unregistered", async () => {
    const alpha = fileIn("Projects/alpha");
    const { context, refs, run } = await loadCommands({ files: [alpha] });
    for (const ref of refs) context.app.workspace.offref(ref);
    context.app.workspace.trigger("file-open", alpha);
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault");
  });

  it("opens the folder of the active file without a notice", async () => {
    const alpha = fileIn("Projects/alpha");
    const { context, run } = await loadCommands({
      activeFile: { parent: { path: "Notes" } },
      files: [alpha],
      opened: [alpha],
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Notes");
  });

  it("opens the folder of the file active last without an active file", async () => {
    const alpha = fileIn("Projects/alpha"),
      older = fileIn("Archive");
    const { context, run } = await loadCommands({
      files: [older, alpha, fileIn("Recent")],
      lastOpenFiles: ["Recent/note.md"],
      opened: [older, alpha, null],
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Projects/alpha");
  });

  it("skips a deleted file and a file outside a folder", async () => {
    const alpha = fileIn("Projects/alpha"),
      gone = fileIn("Projects/beta", "gone.md"),
      external = Object.assign(fileIn("Elsewhere"), { parent: null });
    const { context, run } = await loadCommands({
      files: [alpha, external],
      opened: [alpha, gone, external, null],
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Projects/alpha");
  });

  it("finds a file deleted and created again at the same path", async () => {
    const alpha = fileIn("Projects/alpha"),
      older = fileIn("Archive"),
      files = [older, alpha];
    const { context, run } = await loadCommands({
      files,
      opened: [older, alpha, null],
    });
    // Obsidian makes a new object for a file created after a delete.
    files[1] = fileIn("Projects/alpha");
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Projects/alpha");
  });

  it("finds the only file seen after it was created again at the same path", async () => {
    const alpha = fileIn("Projects/alpha"),
      files = [alpha];
    const { context, run } = await loadCommands({
      files,
      opened: [alpha, null],
    });
    files[0] = fileIn("Projects/alpha");
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Projects/alpha");
  });

  it("skips a remembered path that is a folder now", async () => {
    const alpha = fileIn("Projects/alpha"),
      // Not a TFile, as a folder is not.
      folderIn = (folder: string): MockFile => ({
        parent: { path: folder },
        path: `${folder}/note.md`,
      });
    const { context, run } = await loadCommands({
      files: [
        folderIn("Projects/alpha"),
        folderIn("Recent"),
        fileIn("Archive"),
      ],
      lastOpenFiles: ["Recent/note.md", "Archive/note.md"],
      opened: [alpha, null],
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Archive");
  });

  it("follows a file renamed after it was active", async () => {
    const alpha = fileIn("Projects/alpha");
    const { context, run } = await loadCommands({
      files: [alpha],
      opened: [alpha, null],
    });
    // Obsidian renames a file by changing the same object.
    Object.assign(alpha, {
      parent: { path: "Projects/renamed" },
      path: "Projects/renamed/note.md",
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Projects/renamed");
  });

  it("forgets files after ten newer ones, counting a file active again once", async () => {
    const old = fileIn("Old"),
      newer = Array.from({ length: 9 }, (_, index) =>
        fileIn(`F${String(index)}`),
      );
    const { context, run } = await loadCommands({
      files: [old],
      opened: [old, ...newer, newer[0] ?? null],
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Old");
    vi.mocked(spawnTerminal).mockClear();
    context.app.workspace.trigger("file-open", fileIn("F9"));
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault");
  });

  it("falls back to the newest recent file that still exists", async () => {
    const { context, run } = await loadCommands({
      files: [fileIn("Projects/alpha"), fileIn("Older")],
      lastOpenFiles: [
        "Gone/note.md",
        "Projects/alpha/note.md",
        "Older/note.md",
      ],
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault\\Projects/alpha");
  });

  it("opens the vault root when every recent file was deleted", async () => {
    const { context, run } = await loadCommands({
      lastOpenFiles: ["Gone/note.md"],
      opened: [fileIn("Projects/beta", "gone.md"), null],
    });
    expect(run("open-terminal.integrated.current", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault");
  });

  it("opens the vault root without an active file and without a notice", async () => {
    const { context, run } = await loadCommands();
    expect(run("open-terminal.integrated.root", false)).toBe(true);
    expectSpawnIn(context, "C:\\Vault");
  });

  it("stays silent without a file-system vault", async () => {
    const { run } = await loadCommands({ fileSystem: false });
    expect(run("open-terminal.integrated.current", false)).toBe(false);
    expect(notice2).not.toHaveBeenCalled();
  });

  it("declines a current-directory command while Add to command is off", async () => {
    const alpha = fileIn("Projects/alpha");
    const { context, run } = await loadCommands({
      files: [alpha],
      opened: [alpha, null],
    });
    await context.settings.mutate((value) => {
      value.addToCommand = false;
    });
    expect(run("open-terminal.integrated.current", true)).toBe(false);
    expect(run("open-terminal.integrated.current", false)).toBe(false);
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(notice2).not.toHaveBeenCalled();
  });
});

describe("opening commands on the focused list follow Add to command", () => {
  const OPENING_IDS = [
      "open-terminal.developerConsole",
      "open-terminal.default.root",
      "open-terminal.default.current",
      "open-terminal.external.root",
      "open-terminal.external.current",
      "open-terminal.integrated.root",
      "open-terminal.integrated.current",
      "open-terminal.select.root",
      "open-terminal.select.current",
    ],
    reload = vi.mocked(TerminalView).reloadFocusedHotkeys;

  afterEach(() => {
    vi.mocked(addCommand).mockReset();
    vi.mocked(TerminalView).allowWhileFocused.mockReset();
  });

  async function load(addToCommand: boolean) {
    vi.mocked(addCommand).mockImplementation((_context, name, command) => ({
      ...command,
      name: name(),
    }));
    // The list as the view keeps it: `false` takes a command off.
    const listed = new Set<string>();
    vi.mocked(TerminalView).allowWhileFocused.mockImplementation(
      ({ id }, allowed = true) => {
        if (allowed) listed.add(id);
        else listed.delete(id);
      },
    );
    const context = await terminalContext({ addToCommand });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    loadTerminal(context);
    // The fixture's settings only record their listeners; this runs those
    // whose value changed, as the library's settings manager does.
    const change = async (
      mutator: Parameters<typeof context.settings.mutate>[0],
    ): Promise<void> => {
      const before = context.settings.value;
      await context.settings.mutate(mutator);
      const after = context.settings.value;
      for (const [accessor, callback] of vi.mocked(context.settings).onMutate
        .mock.calls) {
        const previous = accessor(before),
          current = accessor(after);
        if (!isDeepStrictEqual(previous, current)) {
          await callback(current, previous, after);
        }
      }
    };
    return {
      change,
      context,
      listed,
      toggle: async (value: boolean): Promise<void> =>
        change((settings) => {
          settings.addToCommand = value;
        }),
    };
  }

  it("leaves them off the list while Add to command is off", async () => {
    const { listed } = await load(false);

    expect([...listed]).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the default Mod+Shift+H registered while taking its command off the list", async () => {
    const { listed } = await load(false),
      integrated = vi
        .mocked(addCommand)
        .mock.calls.map(([, , command]) => command)
        .find(({ id }) => id === "open-terminal.integrated.current");

    // Obsidian keeps the key; only a focused terminal stops taking it.
    expect(integrated?.hotkeys).toEqual([
      { key: "H", modifiers: ["Mod", "Shift"] },
    ]);
    expect(listed.has("open-terminal.integrated.current")).toBe(false);
  });

  it("lists them while it is on and follows each change at once", async () => {
    const { context, listed, toggle } = await load(true);
    expect([...listed]).toEqual(OPENING_IDS);

    await toggle(false);
    expect([...listed]).toEqual([]);
    expect(reload).toHaveBeenCalledExactlyOnceWith(context);

    await toggle(true);
    expect([...listed]).toEqual(OPENING_IDS);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenLastCalledWith(context);
  });

  it("leaves the list and the hotkeys alone on a change of another setting", async () => {
    const { change, listed } = await load(true);

    await change((settings) => {
      settings.addToContextMenu = !settings.addToContextMenu;
    });

    expect([...listed]).toEqual(OPENING_IDS);
    expect(reload).not.toHaveBeenCalled();
  });

  // The list as the view keeps it, beside the library's settings manager
  // loaded from `data` as at a start.
  async function loadManaged(data: unknown) {
    vi.mocked(addCommand).mockImplementation((_context, name, command) => ({
      ...command,
      name: name(),
    }));
    const listed = new Set<string>();
    vi.mocked(TerminalView).allowWhileFocused.mockImplementation(
      ({ id }, allowed = true) => {
        if (allowed) listed.add(id);
        else listed.delete(id);
      },
    );
    const context = await terminalContext(),
      settings = new SettingsManager(context, Settings.fix),
      local: unknown = Reflect.get(context, "localSettings");
    Object.assign(context, {
      loadData: vi.fn().mockResolvedValue(data),
      // Where the manager keeps a copy of data it fixed; what the fixture
      // already gives this device stays.
      localSettings: {
        mutate: vi.fn().mockResolvedValue(void 0),
        onLoaded: Promise.resolve(),
        write: vi.fn().mockResolvedValue(void 0),
        ...(typeof local === "object" && local !== null ? local : {}),
      },
      settings,
    });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    const write = vi.spyOn(settings, "write").mockResolvedValue(),
      mutate = vi.spyOn(settings, "mutate");
    // Older data can be reported as fixed; that is not this test's concern.
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    settings.load();
    await settings.onLoaded;
    // The manager writes once after it loads.
    await new Promise((resolve) => {
      self.setTimeout(resolve, 0);
    });
    loadTerminal(context);
    // What the start itself may still change and save.
    await new Promise((resolve) => {
      self.setTimeout(resolve, 0);
    });
    return {
      context,
      listed,
      mutate,
      mutates: mutate.mock.calls.length,
      settings,
      write,
      writes: write.mock.calls.length,
    };
  }

  it.each([
    [
      "3.28.0",
      async (): Promise<unknown> => {
        // Imported here so that the import block shared with other changes
        // stays as it is.
        const { default: released } = await import(
          "../../fixtures/data-3.28.0.json",
          { with: { type: "json" } }
        );
        return { ...released, addToCommand: false };
      },
    ],
    [
      "3.29.0",
      async (): Promise<unknown> =>
        // 3.29.0 writes its fixed settings back on every start.
        Promise.resolve(
          JSON.parse(
            JSON.stringify(Settings.fix({ addToCommand: false }).value),
          ),
        ),
    ],
  ])(
    "follows the setting loaded from a %s data.json until the plugin unloads",
    async (_version, data) => {
      const { context, listed, mutate, mutates, settings, write, writes } =
        await loadManaged(await data());
      expect([...listed]).toEqual([]);

      await settings.mutate((value) => {
        value.addToCommand = true;
      });
      expect([...listed]).toEqual(OPENING_IDS);
      expect(reload).toHaveBeenCalledExactlyOnceWith(context);
      // The list follows the setting and stores nothing of its own.
      expect(mutate).toHaveBeenCalledTimes(mutates + 1);
      expect(write).toHaveBeenCalledTimes(writes);

      for (const [dispose] of vi.mocked(context).register.mock.calls) dispose();
      await settings.mutate((value) => {
        value.addToCommand = false;
      });
      expect([...listed]).toEqual(OPENING_IDS);
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "ends with the list of the last of quick changes to %s",
    async (last) => {
      const { listed, settings } = await loadManaged(
          Settings.fix({ addToCommand: !last }).value,
        ),
        set = async (value: boolean): Promise<void> =>
          settings.mutate((settings0) => {
            settings0.addToCommand = value;
          });

      // Not awaited one by one, as clicks on the toggle can be.
      await Promise.all([
        set(last),
        set(!last),
        set(last),
        set(!last),
        set(last),
      ]);

      expect(settings.value.addToCommand).toBe(last);
      expect([...listed]).toEqual(last ? OPENING_IDS : []);
    },
  );

  async function listFrom(initial: unknown): Promise<ReadonlySet<string>> {
    vi.mocked(addCommand).mockImplementation((_context, name, command) => ({
      ...command,
      name: name(),
    }));
    const listed = new Set<string>();
    vi.mocked(TerminalView).allowWhileFocused.mockImplementation(
      ({ id }, allowed = true) => {
        if (allowed) listed.add(id);
        else listed.delete(id);
      },
    );
    const context = await terminalContext(initial);
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    loadTerminal(context);
    return listed;
  }

  it.each([
    ["missing", {}],
    ["a string", { addToCommand: "false" }],
    ["null", { addToCommand: null }],
    ["a number", { addToCommand: 0 }],
  ])(
    "lists them while the stored setting is %s, as it is on by default",
    async (_kind, initial) => {
      expect([...(await listFrom(initial))]).toEqual(OPENING_IDS);
    },
  );

  it.each([
    ["no profiles", { defaultProfile: null, profiles: {} }],
    [
      "only a profile of another platform",
      {
        defaultProfile: "elsewhere",
        profiles: {
          elsewhere: {
            ...Settings.Profile.DEFAULTS.integrated,
            platforms: { darwin: true },
          },
        },
      },
    ],
  ])("lists them by Add to command alone with %s", async (_name, profiles) => {
    expect([...(await listFrom({ ...profiles, addToCommand: true }))]).toEqual(
      OPENING_IDS,
    );
    expect([...(await listFrom({ ...profiles, addToCommand: false }))]).toEqual(
      [],
    );
  });
});

describe("layout-ready automatic Python work", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const found = {
      candidate: "python",
      detail: "",
      executable: "C:\\Python\\python.exe",
      hostExecutable: "C:\\Python\\python.exe",
      status: "ok",
      tried: ["python"],
      version: "3.12.0",
    } satisfies Awaited<ReturnType<typeof checkWindowsPython>>;
    vi.mocked(checkWindowsPython).mockResolvedValue(found);
    vi.mocked(runPluginPythonCheck).mockResolvedValue(found);
    vi.spyOn(CONPTY_HOST_POOL, "ensureSpare").mockImplementation(ensureSpare);
  });
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function layout(
    pythonExecutable: string,
    overridesOnly = false,
    options: {
      readonly used?: boolean;
      readonly prewarm?: boolean;
      readonly consoleHost?: boolean;
      readonly beforeLayout?: (
        context: Awaited<ReturnType<typeof pythonSettingsContext>>,
      ) => void;
      readonly beforeBoot?: (
        context: Awaited<ReturnType<typeof pythonSettingsContext>>,
      ) => unknown;
    } = {},
  ): Promise<Awaited<ReturnType<typeof pythonSettingsContext>>> {
    const profile = Settings.Profile.DEFAULTS.integrated,
      context = await terminalContext({
        pythonExecutable,
        defaultProfile: "overridden",
        prewarmConPty: options.prewarm ?? true,
        windowsTerminalConsoleHost: options.consoleHost ?? true,
        profiles: {
          overridden: {
            ...profile,
            platforms: { win32: true },
            pythonExecutable: "C:\\Unvisited\\python.exe",
          },
          ...(overridesOnly
            ? {}
            : {
                inherited: {
                  ...profile,
                  platforms: { win32: true },
                  pythonExecutable: "",
                },
              }),
        },
      });
    const onLayoutReady = vi.fn<(callback: () => unknown) => void>();
    Object.assign(context.app.workspace, { onLayoutReady });
    Object.assign(context.localSettings, {
      value: LocalSettings.fix({
        ...context.localSettings.value,
        hasUsedIntegratedTerminal: options.used ?? true,
      }).value,
    });
    loadTerminal(context);
    options.beforeLayout?.(context);
    expect(runPluginPythonCheck).not.toHaveBeenCalled();
    onLayoutReady.mock.calls[0]?.[0]();
    await options.beforeBoot?.(context);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(context.localSettings.value.hasUsedIntegratedTerminal).toBe(
      options.used ?? true,
    );
    return context;
  }

  it("keeps the filtered plugin check but boots no spare before first local use", async () => {
    await layout("python", false, { used: false });
    expect(runPluginPythonCheck).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      void 0,
      void 0,
      { includeProfileOverrides: false, refresh: false },
    );
    expect(checkWindowsPython).not.toHaveBeenCalled();
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it("does not schedule a spare while prewarm is disabled", async () => {
    await layout("python", false, { prewarm: false });
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
    expect(checkWindowsPython).not.toHaveBeenCalled();
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it.each([
    "disabled",
    "profile removed",
    "profile incompatible",
    "profile override",
  ])(
    "rechecks current settings before the delayed boot: %s",
    async (change) => {
      await layout("python", false, {
        beforeBoot: async (context) => {
          await context.settings.mutate((settings) => {
            if (change === "disabled") settings.prewarmConPty = false;
            else if (change === "profile removed") settings.profiles = {};
            else {
              const profile = settings.profiles.inherited;
              if (profile?.type !== "integrated")
                throw new Error("Missing integrated profile");
              if (change === "profile incompatible")
                profile.platforms.win32 = false;
              else profile.pythonExecutable = "override-python";
            }
          });
        },
      });
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(ensureSpare).not.toHaveBeenCalled();
    },
  );

  const unload = (
    context: Awaited<ReturnType<typeof pythonSettingsContext>>,
  ): void => {
    for (const [dispose] of vi.mocked(context).register.mock.calls) dispose();
  };

  it("does no layout-ready work after unload", async () => {
    await layout("python", false, { beforeLayout: unload });
    expect(runPluginPythonCheck).not.toHaveBeenCalled();
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it("cancels the delayed startup boot on unload", async () => {
    await layout("python", false, { beforeBoot: unload });
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
    expect(checkWindowsPython).not.toHaveBeenCalled();
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it.each(["plugin", "profile"])(
    "invalidates failures on %s Python edits and changing back, then unsubscribes on unload",
    async (target) => {
      // Use the real settings subscription and resolver; no layout-ready work runs.
      const { checkWindowsPython: checkPython } = await vi.importActual<
          typeof import("../../../src/terminal/win32-doctor.js")
        >("../../../src/terminal/win32-doctor.js"),
        initial = Settings.fix({
          pythonExecutable: "plugin-python",
          profiles: {
            custom: {
              ...Settings.Profile.DEFAULTS.integrated,
              pythonExecutable: "profile-python",
            },
          },
        }).value,
        context = await terminalContext(initial),
        settings = new SettingsManager(context, Settings.fix),
        failed = { code: null, errno: "ENOENT", stdout: "", stderr: "" },
        probe = vi.fn<Win32PythonSpawn>().mockResolvedValue(failed),
        locate = vi.fn().mockResolvedValue(null),
        onLayoutReady = vi.fn();
      Object.assign(context, {
        settings,
        loadData: vi.fn().mockResolvedValue(initial),
      });
      Object.assign(context.app.workspace, { onLayoutReady });
      vi.spyOn(settings, "write").mockResolvedValue();
      vi.spyOn(console, "warn").mockImplementation(vi.fn());
      settings.load();
      await settings.onLoaded;
      loadTerminal(context);
      const check = () =>
        checkPython(context, "profile-python", probe, { locate });
      const failure = await check();
      expect(failure.status).toBe("missing");
      probe.mockClear();
      const pathGeneration = getSystemPathGeneration();
      await settings.mutate((value) => {
        value.addToCommand = !value.addToCommand;
      });
      expect(await check()).toBe(failure);
      expect(probe).not.toHaveBeenCalled();
      const edit = async (python: string): Promise<void> => {
        await settings.mutate((value) => {
          if (target === "plugin") value.pythonExecutable = python;
          else {
            const profile = value.profiles.custom;
            if (profile?.type !== "integrated")
              throw new Error("Missing integrated profile");
            profile.pythonExecutable = python;
          }
        });
      };
      for (const python of ["other-python", `${target}-python`])
        await edit(python);
      expect(probe).not.toHaveBeenCalled();
      expect(getSystemPathGeneration()).toBe(pathGeneration);
      expect(warmSystemPath).not.toHaveBeenCalled();
      expect(runPluginPythonCheck).not.toHaveBeenCalled();
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(ensureSpare).not.toHaveBeenCalled();
      probe.mockResolvedValue({
        code: 0,
        stderr: "",
        stdout: "C:\\Python\\python.exe\n3.12.0\n",
      });
      expect((await check()).status).toBe("ok");
      expect(probe).toHaveBeenCalled();

      // A disposed listener must leave a later failure reusable across edits.
      invalidateWindowsPythonDiagnosis("profile-python", "plugin-python");
      probe.mockResolvedValue(failed);
      const after = await check();
      expect(after.status).toBe("missing");
      unload(context);
      probe.mockClear();
      for (const python of ["other-python", `${target}-python`])
        await edit(python);
      expect(await check()).toBe(after);
      expect(probe).not.toHaveBeenCalled();
      settings.unload();
    },
  );

  it("keeps explicit prewarm enablement available before first use", async () => {
    await layout("python", false, {
      used: false,
      prewarm: false,
      beforeBoot: async (context) => {
        await context.settings.mutate((settings) => {
          settings.prewarmConPty = true;
        });
        // The existing fixture exposes subscriptions; invoke the real load handler.
        for (const [accessor, callback] of vi.mocked(context.settings).onMutate
          .mock.calls) {
          const current = accessor(context.settings.value);
          const previous = accessor(
            Settings.fix({ ...context.settings.value, prewarmConPty: false })
              .value,
          );
          if (current !== previous)
            await callback(current, previous, context.settings.value);
        }
      },
    });
    expect(ensureSpare).toHaveBeenCalledTimes(1);
  });

  /** Turns the console host setting to `to` and runs its load handler. */
  async function switchConsoleHost(
    context: Awaited<ReturnType<typeof pythonSettingsContext>>,
    to: boolean,
  ): Promise<void> {
    const before = context.settings.value;
    await context.settings.mutate((settings) => {
      settings.windowsTerminalConsoleHost = to;
    });
    // The fixture only records subscriptions; run the one that changed. The
    // array-valued accessors build a new array per call, so match booleans.
    for (const [accessor, callback] of vi.mocked(context.settings).onMutate.mock
      .calls) {
      const current = accessor(context.settings.value),
        previous = accessor(before);
      if (typeof current === "boolean" && current !== previous)
        await callback(current, previous, context.settings.value);
    }
  }

  it.each([
    { from: true, to: false },
    { from: false, to: true },
  ])(
    "replaces the spare when the console host setting turns from $from to $to",
    async ({ from, to }) => {
      const context = await layout("python", false, { consoleHost: from });
      expect(ensureSpare).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.anything(),
        from ? "auto" : null,
      );
      const clear = vi.spyOn(CONPTY_HOST_POOL, "clear");
      await switchConsoleHost(context, to);
      await vi.advanceTimersByTimeAsync(0);
      expect(clear).toHaveBeenCalledOnce();
      // The next spare boots after the clear, planning for the new setting.
      expect(ensureSpare).toHaveBeenCalledTimes(2);
      expect(ensureSpare).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.anything(),
        to ? "auto" : null,
      );
      expect(clear.mock.invocationCallOrder[0]).toBeLessThan(
        ensureSpare.mock.invocationCallOrder[1] ?? -1,
      );
    },
  );

  it.each([false, true])(
    "retires the spare without a new one when the console host setting turns to %s before first local use",
    async (to) => {
      const context = await layout("python", false, {
          consoleHost: !to,
          used: false,
        }),
        clear = vi.spyOn(CONPTY_HOST_POOL, "clear");
      await switchConsoleHost(context, to);
      await vi.advanceTimersByTimeAsync(0);
      expect(clear).toHaveBeenCalledOnce();
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(ensureSpare).not.toHaveBeenCalled();
    },
  );

  it("retires the spare without a new one when the console host setting changes while prewarm is off", async () => {
    const context = await layout("python", false, { prewarm: false }),
      clear = vi.spyOn(CONPTY_HOST_POOL, "clear");
    await switchConsoleHost(context, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(clear).toHaveBeenCalledOnce();
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it.each(["", "python", "C:\\Python\\python.exe", "D:/Tools/python.exe"])(
    "checks only the plugin and prewarms an inheriting profile for %j",
    async (value) => {
      await layout(value);
      expect(runPluginPythonCheck).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        void 0,
        void 0,
        { includeProfileOverrides: false, refresh: false },
      );
      expect(checkWindowsPython).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        value,
      );
      expect(ensureSpare).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "/opt/python3",
    "\\tools\\python.exe",
    "\\\\server\\share\\python.exe",
    "bin/python",
    "C:python.exe",
  ])(
    "runs no automatic Python work for excluded plugin value %s",
    async (value) => {
      await layout(value);
      expect(runPluginPythonCheck).not.toHaveBeenCalled();
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(ensureSpare).not.toHaveBeenCalled();
    },
  );

  it("does not prewarm when every profile overrides Python", async () => {
    await layout("python", true);
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
    expect(checkWindowsPython).not.toHaveBeenCalled();
    expect(ensureSpare).not.toHaveBeenCalled();
  });
});

describe("built-in keymappings at the start of the plugin", () => {
  const windows = {
      action: "sendToObsidian",
      actionArg: null,
      alt: false,
      ctrl: true,
      key: "p",
      meta: false,
      platform: "win32",
      shift: false,
    } as const satisfies Settings.Keymapping,
    macOS = {
      ...windows,
      ctrl: false,
      meta: true,
      platform: "darwin",
    } as const satisfies Settings.Keymapping,
    own = {
      action: "sendText",
      actionArg: "ls\\n",
      alt: true,
      ctrl: false,
      key: "l",
      meta: false,
      platform: null,
      shift: false,
    } as const satisfies Settings.Keymapping,
    // The list 3.29.0 saves for a user with one entry of their own.
    list329: readonly Settings.Keymapping[] = [
      own,
      ...Settings.DEFAULT.keymappings.filter(
        ({ action }) => action !== "sendToObsidian",
      ),
    ];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // A data.json as 3.29.0 writes it: no version and no palette keys.
  function released329(
    keymappings: readonly Settings.Keymapping[] = list329,
    extra: object = {},
  ): unknown {
    const { keymappingDefaultsVersion: _version, ...rest } = Settings.DEFAULT,
      stored: unknown = JSON.parse(
        JSON.stringify({ ...rest, keymappings, ...extra }),
      );
    return stored;
  }

  // The data.json a device on 3.29.0 saves after it read `keymappings`: it
  // knows no Send to Obsidian, so it makes the action Ignore.
  function saved329(keymappings: readonly Settings.Keymapping[]): unknown {
    return released329(
      keymappings.map((mapping) =>
        mapping.action === "sendToObsidian"
          ? { ...mapping, action: "ignore" }
          : mapping,
      ),
    );
  }

  // Loads `stored` through the real settings manager, then the terminal.
  async function start(stored: unknown) {
    // The local settings below log their missing changelog version.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const context = await terminalContext(),
      settings = new TerminalSettingsManager(context, Settings.fix),
      // Takes the copy of data.json the manager keeps when it is malformed.
      recovery = vi.fn();
    Object.assign(context, {
      settings,
      loadData: vi.fn().mockResolvedValue(stored),
      localSettings: {
        mutate: recovery,
        onMutate: vi.fn().mockReturnValue(vi.fn()),
        value: LocalSettings.fix({}).value,
        write: vi.fn(),
      },
    });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    const write = vi.spyOn(settings, "write").mockResolvedValue();
    settings.load();
    await settings.onLoaded;
    await tick();
    write.mockClear();
    const mutate = vi.spyOn(settings, "mutate");
    loadTerminal(context);
    await tick();
    return { context, mutate, recovery, settings, write };
  }

  it("adds the palette keys to a data.json of 3.29.0 once, after the user's entries", async () => {
    const first = await start(released329());
    expect(first.recovery).not.toHaveBeenCalled();
    expect(first.settings.value.keymappings).toStrictEqual([
      ...list329,
      windows,
      macOS,
    ]);
    expect(first.settings.value.keymappingDefaultsVersion).toBe(1);
    expect(first.mutate).toHaveBeenCalledOnce();
    expect(first.write).toHaveBeenCalledOnce();

    const saved: unknown = JSON.parse(JSON.stringify(first.settings.value)),
      second = await start(saved);
    expect(second.settings.value).toStrictEqual(first.settings.value);
    expect(second.mutate).not.toHaveBeenCalled();
    expect(second.write).not.toHaveBeenCalled();
  });

  it("puts back the palette keys a device on 3.29.0 made Ignore", async () => {
    const { settings } = await start(
      released329([
        ...list329,
        { ...windows, action: "ignore" },
        { ...macOS, action: "ignore" },
      ]),
    );
    expect(settings.value.keymappings).toStrictEqual([
      ...list329,
      windows,
      macOS,
    ]);
    expect(settings.value.keymappingDefaultsVersion).toBe(1);
  });

  it("puts back the palette keys a device on 3.29.0 made Ignore after a reload of its data.json", async () => {
    // This device updated and offered the keys; a device still on 3.29.0
    // then saved data.json with them as Ignore and without the version.
    const { settings } = await start(released329()),
      rewritten = released329([
        ...list329,
        { ...windows, action: "ignore" },
        { ...macOS, action: "ignore" },
      ]);
    // Settings → All settings → Reload.
    await settings.read(() => rewritten);
    const saved: unknown = JSON.parse(JSON.stringify(settings.value)),
      next = await start(saved);
    expect(next.settings.value.keymappings).toStrictEqual([
      ...list329,
      windows,
      macOS,
    ]);
  });

  it("adds a deleted palette key again at each start after a device on 3.29.0 saved data.json", async () => {
    let { settings } = await start(released329());
    for (let round = 0; round < 2; round++) {
      // Settings → Keymappings: the user deletes Ctrl+P. This version keeps
      // the deletion at its next start.
      const deleted = settings.value.keymappings.filter(
          ({ action, platform }) =>
            action !== "sendToObsidian" || platform !== "win32",
        ),
        saved: unknown = JSON.parse(
          JSON.stringify({ ...settings.value, keymappings: deleted }),
        ),
        own = await start(saved);
      expect(own.settings.value.keymappings).toStrictEqual([...list329, macOS]);
      expect(own.mutate).not.toHaveBeenCalled();

      ({ settings } = await start(saved329(own.settings.value.keymappings)));
      expect(settings.value.keymappings).toStrictEqual([
        ...list329,
        macOS,
        windows,
      ]);
    }
  });

  it("keeps a palette key set to Passthrough after a device on 3.29.0 saved data.json", async () => {
    // Settings → Keymappings: the user sets Ctrl+P to Passthrough.
    const passthrough = {
      ...windows,
      action: "passthrough",
    } as const satisfies Settings.Keymapping;
    let keymappings: readonly Settings.Keymapping[] = [
      ...list329,
      passthrough,
      macOS,
    ];
    for (let round = 0; round < 2; round++) {
      // 3.29.0 knows Passthrough and keeps it.
      const { settings } = await start(saved329(keymappings));
      ({ keymappings } = settings.value);
      expect(keymappings).toStrictEqual([...list329, passthrough, macOS]);
    }
  });

  it("adds no palette key twice to a list that has them, at this start or the next", async () => {
    const { context, mutate, settings, write } = await start(
      released329(Settings.DEFAULT.keymappings, {
        keymappingDefaultsVersion: 0,
      }),
    );
    expect(settings.value.keymappings).toStrictEqual(
      Settings.DEFAULT.keymappings,
    );
    expect(settings.value.keymappingDefaultsVersion).toBe(1);
    expect(write).toHaveBeenCalledOnce();

    loadTerminal(context);
    await tick();
    expect(settings.value.keymappings).toStrictEqual(
      Settings.DEFAULT.keymappings,
    );
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("changes nothing once the palette keys were offered", async () => {
    const stored: unknown = JSON.parse(
        JSON.stringify({ ...Settings.DEFAULT, keymappings: [own] }),
      ),
      { mutate, settings, write } = await start(stored);
    expect(settings.value.keymappings).toStrictEqual([own]);
    expect(mutate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("logs a failed update and loads on", async () => {
    const error = new Error("mutate failed"),
      logged = vi.spyOn(console, "error").mockImplementation(() => {}),
      context = await terminalContext({ keymappingDefaultsVersion: 0 });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    // The context's settings are mocks already, which spying hands back.
    const mutate = vi.spyOn(context.settings, "mutate"),
      write = vi.spyOn(context.settings, "write");
    mutate.mockClear().mockRejectedValueOnce(error);
    write.mockClear();

    expect(() => {
      loadTerminal(context);
    }).not.toThrow();
    await tick();

    expect(mutate).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(error);
    expect(write).not.toHaveBeenCalled();
  });

  it("logs a failed save of the update and loads on", async () => {
    const error = new Error("write failed"),
      logged = vi.spyOn(console, "error").mockImplementation(() => {}),
      context = await terminalContext({ keymappingDefaultsVersion: 0 });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    const mutate = vi.spyOn(context.settings, "mutate"),
      write = vi.spyOn(context.settings, "write");
    mutate.mockClear();
    write.mockClear().mockRejectedValueOnce(error);

    expect(() => {
      loadTerminal(context);
    }).not.toThrow();
    await tick();

    expect(mutate).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(error);
  });
});

describe("ConPTY host settings invalidation", () => {
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function loadedSettings() {
    const initial = Settings.fix({
        pythonExecutable: "plugin-python",
        profiles: {
          custom: {
            ...Settings.Profile.DEFAULTS.integrated,
            platforms: { win32: true },
            pythonExecutable: "profile-python",
          },
        },
      }).value,
      context = await terminalContext(initial),
      settings = new SettingsManager(context, Settings.fix);
    Object.assign(context, {
      settings,
      loadData: vi.fn().mockResolvedValue(initial),
    });
    // A used plugin: a console host change prewarms only after first use.
    Object.assign(context.localSettings, {
      value: LocalSettings.fix({
        ...context.localSettings.value,
        hasUsedIntegratedTerminal: true,
      }).value,
    });
    Object.assign(context.app.workspace, { onLayoutReady: vi.fn() });
    vi.spyOn(settings, "write").mockResolvedValue();
    settings.load();
    await settings.onLoaded;
    loadTerminal(context);
    return {
      settings,
      unload: (): void => {
        for (const [dispose] of vi.mocked(context).register.mock.calls)
          dispose();
      },
    };
  }

  it.each([
    "plugin Python",
    "profile Python",
    "backend",
    "Windows compatibility",
    "profile removal",
    "profile identity",
    "profile type",
  ])(
    "reaps the old spare after changing %s without rewarming",
    async (change) => {
      const fixture = await loadedSettings();
      try {
        await withPythonSpare("old-python", async ({ host, control }) => {
          await fixture.settings.mutate((settings) => {
            const profile = settings.profiles.custom;
            if (profile?.type !== "integrated")
              throw new Error("Missing integrated profile");
            switch (change) {
              case "plugin Python":
                settings.pythonExecutable = "new-python";
                break;
              case "profile Python":
                profile.pythonExecutable = "new-python";
                break;
              case "backend":
                profile.win32Backend = "legacy";
                break;
              case "Windows compatibility":
                profile.platforms.win32 = false;
                break;
              case "profile removal":
                delete settings.profiles.custom;
                break;
              case "profile identity":
                settings.profiles.renamed = profile;
                delete settings.profiles.custom;
                break;
              case "profile type":
                Object.assign(profile, { type: "external" });
                break;
            }
          });
          expect(host.killed).toBe(true);
          await expect(control.ready).rejects.toMatchObject({
            reason: "aborted",
          });
          expect(CONPTY_HOST_POOL.acquire("old-python")).toBeNull();
          expect(checkWindowsPython).not.toHaveBeenCalled();
          expect(runPluginPythonCheck).not.toHaveBeenCalled();
        });
      } finally {
        fixture.unload();
        fixture.settings.unload();
      }
    },
  );

  it.each([false, true])(
    "reaps the old spare after turning the console host setting to %s",
    async (to) => {
      const fixture = await loadedSettings();
      try {
        await fixture.settings.mutate((settings) => {
          settings.windowsTerminalConsoleHost = !to;
        });
        await withPythonSpare("old-python", async ({ host, control }) => {
          await fixture.settings.mutate((settings) => {
            settings.windowsTerminalConsoleHost = to;
          });
          expect(host.killed).toBe(true);
          await expect(control.ready).rejects.toMatchObject({
            reason: "aborted",
          });
          expect(CONPTY_HOST_POOL.acquire("old-python")).toBeNull();
          // Its only profile overrides Python, so no spare replaces it.
          expect(checkWindowsPython).not.toHaveBeenCalled();
        });
      } finally {
        fixture.unload();
        fixture.settings.unload();
      }
    },
  );

  it("keeps the spare for unrelated edits and unregisters on unload", async () => {
    const fixture = await loadedSettings();
    try {
      await withPythonSpare("old-python", async (spare) => {
        await fixture.settings.mutate((settings) => {
          settings.addToCommand = !settings.addToCommand;
          const profile = settings.profiles.custom;
          if (profile?.type !== "integrated")
            throw new Error("Missing integrated profile");
          profile.name = "Renamed terminal";
          profile.terminalOptions.theme = { foreground: "#123456" };
        });
        const retained = CONPTY_HOST_POOL.acquire("old-python");
        expect(retained?.host).toBe(spare.host);
        if (!retained) throw new Error("Unrelated edit discarded the spare");
        CONPTY_HOST_POOL.release("old-python", retained);
        fixture.unload();
        await fixture.settings.mutate((settings) => {
          settings.pythonExecutable = "new-python";
        });
        expect(CONPTY_HOST_POOL.acquire("old-python")?.host).toBe(spare.host);
        expect(spare.host.killed).toBe(false);
      });
    } finally {
      fixture.unload();
      fixture.settings.unload();
    }
  });
});
