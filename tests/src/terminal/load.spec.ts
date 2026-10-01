import {
  SettingsManager,
  addRibbonIcon,
  createI18n,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import { FileSystemAdapter, Menu } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginLocales } from "../../../assets/locales.js";
import {
  pythonSettingsContext,
  withPythonSpare,
} from "../../fixtures/python-settings-ui.js";
import { LocalSettings, Settings } from "../../../src/settings-data.js";
import { loadTerminal } from "../../../src/terminal/load.js";
import { CONPTY_HOST_POOL } from "../../../src/terminal/pseudoterminal.js";
import {
  SelectProfileModal,
  spawnTerminal,
} from "../../../src/terminal/spawn.js";
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

const ribbonMenu = vi.hoisted(() => {
  class Item {
    public readonly setTitle = vi.fn((_title: string) => this);
    public readonly onClick = vi.fn((_callback: () => void) => this);
  }
  const items: (Item | null)[] = [];
  return { Item, items, showAtMouseEvent: vi.fn(), openSelector: vi.fn() };
});

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  FileSystemAdapter: vi.fn(),
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
  TerminalView: { load: vi.fn() },
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
  async function ribbon(defaultProfile: string | null = "integrated") {
    const context = await terminalContext({
      defaultProfile,
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
    for (const [accessor, callback] of vi.mocked(context.settings).onMutate.mock
      .calls) {
      const previous = accessor(context.settings.value);
      const next = accessor(
        Settings.fix({ ...context.settings.value, defaultProfile: null }).value,
      );
      if (previous !== next && typeof previous === "string")
        await callback(next, previous, context.settings.value);
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
      readonly beforeLayout?: (
        context: Awaited<ReturnType<typeof pythonSettingsContext>>,
      ) => void;
      readonly beforeBoot?: (
        context: Awaited<ReturnType<typeof pythonSettingsContext>>,
      ) => unknown;
    } = {},
  ): Promise<void> {
    const profile = Settings.Profile.DEFAULTS.integrated,
      context = await terminalContext({
        pythonExecutable,
        defaultProfile: "overridden",
        prewarmConPty: options.prewarm ?? true,
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
    Object.assign(context, {
      localSettings: {
        value: LocalSettings.fix({
          hasUsedIntegratedTerminal: options.used ?? true,
        }).value,
      },
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
