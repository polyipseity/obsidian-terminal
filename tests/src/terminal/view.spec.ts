/**
 * Unit tests for `src/terminal/view.ts` — tab names, opening, and placement.
 *
 * Covers:
 * - `TerminalView.State` defaults and `fix()`
 * - `getDisplayText`
 * - `spawn` reveal and focus rules
 * - `getLeaf` session-usage anchoring
 * - `fileLinkLeaf`: the leaf a clicked vault file link opens in
 * - Copy and edit pane-menu entries
 * - `focus` reveal ordering and failure handling
 * - Program status on the tab while its experiment is on, and nothing of it
 *   while off
 * - `dressUnloadedTabs`: the icon and size of tabs whose view is not loaded
 */
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import * as library from "@polyipseity/obsidian-plugin-library";
import { readStateCollaboratively } from "@polyipseity/obsidian-plugin-library";
import {
  App,
  type Menu,
  type MenuItem,
  View,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { TerminalPlugin } from "../../../src/main.js";
import { TERMINAL_CONPTY_HOST_EXIT_WAIT } from "../../../src/magic.js";
import { tabIconId } from "../../../src/icons.js";
import { Settings } from "../../../src/settings-data.js";
import { ProgramStatusAddon } from "../../../src/terminal/emulator-addons.js";
import * as environment from "../../../src/terminal/environment.js";
import { mergeTerminalOptions } from "../../../src/terminal/options.js";
import * as profileProperties from "../../../src/terminal/profile-properties.js";
import { DETECTION_REPLY } from "../../../src/terminal/program-status.js";
import { TabStatusPresenter } from "../../../src/terminal/tab-status.js";
import {
  ConPtyControlError,
  ConPtyPseudoterminal,
  type ConPtyControlChannel,
  type ConPtyPseudoterminalDependencies,
  type ConPtyReadyEvent,
  type Pseudoterminal,
} from "../../../src/terminal/pseudoterminal.js";
import {
  EditTerminalModal,
  TerminalView,
  fittedSize,
  settleTerminalBackendOptions,
} from "../../../src/terminal/view.js";
import { microtasks, pseudoterminal, tick } from "../../support/helpers.js";

const platform = vi.hoisted(() => ({ windows: false }));
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
        return platform.windows ? "win32" : actual.Platform.CURRENT;
      },
    },
  };
});

vi.mock("obsidian", async () => {
  // The shared mock has no base View; ItemView supplies its leaf contract here.
  const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
  return {
    ...actual,
    View: actual.ItemView,
    // Watched: the tabs whose view is not loaded get their icon through it.
    setIcon: vi.fn<typeof actual.setIcon>(),
  };
});

/*
 * The two classes of the tab status feature are watched as they are made:
 * while the feature is off, neither may be. They work as they do in the app:
 * an object made by `new` on a mock gets the prototype of the mock, so each
 * mock is a plain function that hands back an object of the real class.
 */
vi.mock("../../../src/terminal/emulator-addons.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/terminal/emulator-addons.js")
    >();
  return {
    ...actual,
    ProgramStatusAddon: vi.fn(function make(
      ...args: ConstructorParameters<typeof actual.ProgramStatusAddon>
    ) {
      return new actual.ProgramStatusAddon(...args);
    }),
  };
});
vi.mock("../../../src/terminal/tab-status.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/terminal/tab-status.js")
    >();
  return {
    ...actual,
    TabStatusPresenter: vi.fn(function make(
      ...args: ConstructorParameters<typeof actual.TabStatusPresenter>
    ) {
      return new actual.TabStatusPresenter(...args);
    }),
  };
});

/*
 * Mock `src/imports.js` — the BUNDLE map provides lazy `require()` loaders for
 * xterm addon packages that are not built/available in the test environment.
 * Replacing the map entries with no-op factories prevents unhandled rejections
 * from `dynamicRequire`.
 */
vi.mock("../../../src/imports.js", () => {
  class DummyAddon {
    public readonly onDidChangeResults = vi.fn();
  }
  const dummy = (): Record<string, unknown> => ({
    CanvasAddon: DummyAddon,
    LigaturesAddon: DummyAddon,
    SearchAddon: DummyAddon,
    Unicode11Addon: DummyAddon,
    WebLinksAddon: DummyAddon,
    WebglAddon: DummyAddon,
  });
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

// Fixtures supply only the host API used here; this boundary cast bridges the
// intentionally partial plugin stub to the full plugin type.
function makeTerminalContext(overrides: Partial<Settings> = {}) {
  const app = new App();
  const settings = { ...Settings.DEFAULT, ...overrides };
  const context = {
    id: "terminal",
    app,
    settings: { value: settings, onMutate: vi.fn(() => vi.fn()) },
    language: {
      value: { t: vi.fn((key: string) => key) },
      onChangeLanguage: { listen: vi.fn(() => vi.fn()) },
    },
    statusBarHider: { hide: vi.fn(() => vi.fn()), update: vi.fn() },
  } as unknown as TerminalPlugin;
  const { workspace } = app;
  const next = makeTerminalLeaf(context).leaf;
  return {
    context,
    settings,
    workspace,
    next,
    allocate: vi.spyOn(workspace, "getLeaf").mockReturnValue(next),
    reveal: vi.spyOn(workspace, "revealLeaf"),
    activate: vi.spyOn(workspace, "setActiveLeaf"),
  };
}

const terminalViews: TerminalView[] = [];

function makeTerminalLeaf(context: TerminalPlugin) {
  const leaf = new WorkspaceLeaf();
  const view = new TerminalView(context, leaf);
  view.app = context.app;
  // Obsidian gives every element this; the test DOM does not.
  Object.assign(view.contentEl, { onWindowMigrated: vi.fn(() => vi.fn()) });
  view.load();
  terminalViews.push(view);
  // Call matchers compare arguments structurally; the id keeps two mock leaves
  // in the same state from matching each other.
  Object.assign(leaf, { view, id: terminalViews.length });
  vi.spyOn(view, "getViewType").mockReturnValue(
    TerminalView.type.namespaced(context),
  );
  return { leaf, view, setViewState: vi.spyOn(leaf, "setViewState") };
}

function deferred() {
  // The promise executor assigns the resolver synchronously.
  let resolve!: (value: undefined) => void;
  const promise = new Promise<undefined>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const view of terminalViews.splice(0)) view.unload();
  vi.restoreAllMocks();
});

describe("hotkeys while a terminal has focus", () => {
  type Command = ReturnType<typeof library.addCommand>;
  interface Hotkey {
    readonly modifiers: readonly string[];
    readonly key: string;
  }
  interface CompiledHotkey {
    readonly modifiers: string;
    readonly key: string;
  }

  // `Mod` stays symbolic: the table and the pressed key are compiled alike.
  const compile = (modifiers: readonly string[]): string =>
      [...modifiers].sort((left, right) => left.localeCompare(right)).join(","),
    // Stands in for `Keymap.isMatch`.
    isMatch = (hotkey: CompiledHotkey, pressed: CompiledHotkey): boolean =>
      hotkey.modifiers === pressed.modifiers && hotkey.key === pressed.key;

  /**
   * The hotkey table of Obsidian 1.14.4. Every change marks it stale, the
   * user-assigned keys are handed out as a copy, and `bake` lists them before
   * the default keys of the commands the user did not rebind.
   */
  class HotkeyTable {
    public defaultKeys: Record<string, readonly Hotkey[]> = {};
    public baked = false;
    public bakedHotkeys: readonly CompiledHotkey[] = [];
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

  // Runs the real `TerminalView.load` and the library's real hotkey listener
  // against the Obsidian parts both of them reach for.
  function loadView() {
    const { context } = makeTerminalContext(),
      hotkeys = new HotkeyTable(),
      registry = new Map<string, Command>(),
      // Obsidian runs the check with `false` and reports success unless it throws.
      executeCommand = vi.fn((command: Command): boolean => {
        command.checkCallback?.(false);
        return true;
      }),
      // The mock `Scope` cannot take the catch-all `null, null` the view registers.
      register = vi.spyOn(ScopeView.scope, "register").mockReturnValue({
        key: null,
        modifiers: null,
        scope: ScopeView.scope,
      });
    Object.assign(context.app, {
      commands: {
        executeCommand,
        findCommand: (id: string): Command | undefined => registry.get(id),
      },
      hotkeyManager: hotkeys,
      keymap: { constructor: { isMatch } },
    });
    Object.assign(context, {
      // `Plugin.addCommand` prefixes the id; the table learns the default keys.
      addCommand: (command: Command): Command => {
        command.id = `terminal:${command.id}`;
        registry.set(command.id, command);
        if (command.hotkeys?.length) {
          hotkeys.addDefaultHotkeys(command.id, command.hotkeys);
        }
        return command;
      },
      register: vi.fn(),
      registerEvent: vi.fn(),
      registerView: vi.fn(),
    });
    TerminalView.load(context);
    // Spying again hands back the same spy, so a second load in one test
    // finds its own listener in the last call.
    const listener = register.mock.lastCall?.[2];
    if (!listener) throw new Error("Missing focused-scope listener");
    return {
      executeCommand,
      // The user's own hotkey and no default one, as on an opening command.
      addBoundCommand: (id: string, hotkey: Hotkey) => {
        const check = vi.fn((_checking: boolean): boolean => true),
          command = library.addCommand(context, () => id, {
            checkCallback: check,
            id,
          });
        hotkeys.setHotkeys(command.id, [hotkey]);
        return { check, command };
      },
      // Hands back what the listener answers Obsidian: after `false` Obsidian
      // consumes the key, after `undefined` the key goes on to the terminal.
      press: (modifiers: readonly string[], key: string): unknown =>
        listener(new KeyboardEvent("keydown", { key }), {
          key,
          modifiers: compile(modifiers),
          vkey: key,
        }),
    };
  }

  it("leaves the hotkey of a command outside the list to the terminal", () => {
    const { addBoundCommand, executeCommand, press } = loadView(),
      { check } = addBoundCommand("open-terminal.external.root", {
        key: "t",
        modifiers: ["Alt", "Ctrl"],
      });

    expect(press(["Ctrl", "Alt"], "t")).toBeUndefined();

    expect(executeCommand).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("leaves a key that no hotkey matches to the terminal", () => {
    const { executeCommand, press } = loadView();

    expect(press(["Ctrl"], "r")).toBeUndefined();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("runs the user-assigned hotkey of a command added with allowWhileFocused", () => {
    const { addBoundCommand, executeCommand, press } = loadView(),
      { check, command } = addBoundCommand("open-terminal.external.root", {
        key: "t",
        modifiers: ["Alt", "Ctrl"],
      });
    TerminalView.allowWhileFocused(command);

    // The key ran a command, so it must not reach the shell as well.
    expect(press(["Ctrl", "Alt"], "t")).toBe(false);

    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(command);
    expect(check).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps the terminal's own hotkeys and lets no other command through", () => {
    const { addBoundCommand, executeCommand, press } = loadView();
    TerminalView.allowWhileFocused(
      addBoundCommand("open-terminal.external.root", {
        key: "t",
        modifiers: ["Alt", "Ctrl"],
      }).command,
    );
    addBoundCommand("command-palette", { key: "p", modifiers: ["Mod"] });

    expect(press(["Mod"], "p")).toBeUndefined();
    expect(executeCommand).not.toHaveBeenCalled();

    expect(press(["Mod", "Shift"], "k")).toBe(false);
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "terminal:clear-terminal" }),
    );
  });

  it("forgets the commands of an earlier load", () => {
    const hotkey = { key: "t", modifiers: ["Alt", "Ctrl"] },
      earlier = loadView();
    TerminalView.allowWhileFocused(
      earlier.addBoundCommand("open-terminal.external.root", hotkey).command,
    );
    const { addBoundCommand, executeCommand, press } = loadView(),
      { check } = addBoundCommand("open-terminal.external.root", hotkey);

    press(["Ctrl", "Alt"], "t");

    expect(executeCommand).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("honours a command allowed after a bake only once the hotkey table is stale again", () => {
    const { addBoundCommand, executeCommand, press } = loadView(),
      { command } = addBoundCommand("open-terminal.external.root", {
        key: "t",
        modifiers: ["Alt", "Ctrl"],
      });

    // The first key bakes the table, without the command.
    press(["Ctrl", "Alt"], "t");
    expect(executeCommand).not.toHaveBeenCalled();

    TerminalView.allowWhileFocused(command);
    press(["Ctrl", "Alt"], "t");
    expect(executeCommand).not.toHaveBeenCalled();

    // Any change of a hotkey marks the table stale.
    addBoundCommand("command-palette", { key: "p", modifiers: ["Mod"] });
    press(["Ctrl", "Alt"], "t");
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith(command);
  });
});

describe("src/terminal/view.ts", () => {
  describe("exit notices", () => {
    const exitCodes: readonly Awaited<Pseudoterminal["onExit"]>[] = [
      1,
      "SIGTERM",
      0,
    ];
    class TestView extends TerminalView {
      public override startEmulator(focus: boolean): void {
        super.startEmulator(focus);
      }

      public stopEmulator(): void {
        this.emulator = null;
      }

      public createConPty(
        dependencies: ConPtyPseudoterminalDependencies,
      ): ConPtyPseudoterminal {
        return new ConPtyPseudoterminal(
          this.context,
          { executable: "cmd.exe", pythonExecutable: "python" },
          dependencies,
        );
      }
    }

    afterEach(() => {
      platform.windows = false;
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    async function startView(
      ...ptys: readonly Promise<Pseudoterminal>[]
    ): Promise<TestView> {
      platform.windows = true;
      const pending = ptys.values();
      vi.spyOn(library, "awaitCSS").mockImplementation(async (element) => {
        Object.assign(element, { onWindowMigrated: vi.fn() });
      });
      vi.spyOn(library, "notice2").mockImplementation(vi.fn());
      vi.spyOn(library, "onResize").mockImplementation(vi.fn());
      vi.spyOn(TerminalView, "EMULATOR").mockImplementation(
        function (_element, _factory, _state, _options, addons) {
          const pty = pending.next().value;
          if (!pty) throw new Error("Missing test pseudoterminal");
          // Only the view-facing emulator surface is needed; rendering belongs
          // to emulator.spec.ts. Keep the actual addon callbacks from the view.
          return {
            addons,
            close: vi.fn(async () => {
              const opened = await pty.catch(() => null);
              await opened?.kill();
            }),
            pseudoterminal: pty,
            resize: vi.fn().mockResolvedValue(undefined),
            terminal: {
              unicode: {},
              onWriteParsed: vi.fn(),
              onResize: vi.fn(),
              onTitleChange: vi.fn(),
            },
          } as unknown as TerminalView.EMULATOR;
        },
      );
      const context = {
          language: { value: { t: vi.fn((key: string) => key) } },
          settings: { value: Settings.DEFAULT, onMutate: vi.fn() },
        } as unknown as ConstructorParameters<typeof TerminalView>[0],
        view = new TestView(context, new WorkspaceLeaf());
      view.startEmulator(false);
      await tick();
      // The spawn notice proves that setup completed before exercising exits.
      expect(library.notice2).toHaveBeenCalledOnce();
      vi.mocked(library.notice2).mockClear();
      return view;
    }

    it("forwards the emulator factory's abort signal into openProfile", async () => {
      const exit = Promise.withResolvers<number>(),
        view = await startView(
          Promise.resolve({ ...pseudoterminal(), onExit: exit.promise }),
        ),
        call = vi.mocked(TerminalView.EMULATOR).mock.calls[0];
      if (!call?.[4]) throw new Error("Missing emulator factory or addons");
      const [, factory, , , addons] = call,
        controller = new AbortController(),
        terminal = new Terminal(),
        aborted = new ConPtyControlError("aborted"),
        open = vi
          .spyOn(profileProperties, "openProfile")
          .mockRejectedValue(aborted);
      try {
        controller.abort();
        await expect(
          factory(
            terminal,
            {
              ...addons,
              fit: new FitAddon(),
              serialize: new SerializeAddon(),
            },
            controller.signal,
          ),
        ).rejects.toBe(aborted);
        expect(open).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ signal: controller.signal }),
        );
      } finally {
        terminal.dispose();
        view.stopEmulator();
        exit.resolve(0);
      }
    });

    it("opens vault file links outside the terminal's own leaf", async () => {
      const exit = Promise.withResolvers<number>(),
        view = await startView(
          Promise.resolve({ ...pseudoterminal(), onExit: exit.promise }),
        ),
        addons = vi.mocked(TerminalView.EMULATOR).mock.calls[0]?.[4];
      try {
        if (!addons) throw new Error("Missing emulator factory or addons");
        view.app = new App();
        // Clicking a link in the terminal makes it the active leaf.
        view.app.workspace.setActiveLeaf(view.leaf);
        expect(addons.vaultFileLinks["fileLeaf"]()).not.toBe(view.leaf);
        // The addon asks the view's picker, which answers a remembered note.
        const note = new WorkspaceLeaf();
        vi.spyOn(view.app.workspace, "getLeavesOfType").mockReturnValue([note]);
        TerminalView["lastActiveNoteLeaf"] = new WeakRef(note);
        expect(addons.vaultFileLinks["fileLeaf"]()).toBe(note);
      } finally {
        TerminalView["lastActiveNoteLeaf"] = null;
        view.stopEmulator();
        exit.resolve(0);
      }
    });

    const startupExits = [
      [9009, "errors.win32-exit-9009"],
      [251, "errors.win32-exit-251"],
      [0xc0000142, "errors.win32-exit-c0000142"],
      [-1073741502, "errors.win32-exit-c0000142"],
    ] satisfies readonly (readonly [number, string])[];

    function expectExitNotice(key: string): void {
      expect(library.notice2).toHaveBeenCalledOnce();
      expect(vi.mocked(library.notice2).mock.calls[0]?.[0]()).toBe(key);
    }

    async function startConPtyView() {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(environment, "applyEnv").mockResolvedValue({});
      const opened = Promise.withResolvers<Pseudoterminal>(),
        view = await startView(opened.promise),
        ready = Promise.withResolvers<ConPtyReadyEvent>(),
        stdin = new PassThrough(),
        stdout = new PassThrough(),
        stderr = new PassThrough(),
        host = Object.assign(new ChildProcess(), {
          pid: 100,
          stdin,
          stdout,
          stderr,
          stdio: [stdin, stdout, stderr, null, null] satisfies Awaited<
            ReturnType<ConPtyPseudoterminalDependencies["spawn"]>
          >["stdio"],
        }),
        control: ConPtyControlChannel = {
          armReadyDeadline: vi.fn(),
          dispose: vi.fn(async () => {
            ready.reject(new ConPtyControlError("aborted"));
          }),
          hello: Promise.resolve({
            childPid: 200,
            event: "hello",
            hostPid: 100,
            token: "token",
          }),
          kill: vi.fn().mockResolvedValue(undefined),
          path: "test-control-pipe",
          ready: ready.promise,
          reportedExitCode: vi.fn(() => null),
          resize: vi.fn().mockResolvedValue(undefined),
          token: "token",
        };
      vi.spyOn(host, "kill").mockImplementation(() => {
        Object.assign(host, { signalCode: "SIGTERM" });
        host.emit("exit", null, "SIGTERM");
        return true;
      });
      const pty = view.createConPty({
        createControl: vi.fn().mockResolvedValue(control),
        materializeSource: vi.fn().mockResolvedValue("test-host.py"),
        source: Promise.resolve("test host"),
        spawn: vi.fn().mockResolvedValue(host),
      });
      // ShellPseudoterminal normally supplies the selected backend tag.
      opened.resolve(
        Object.assign(pty, {
          win32Backend: "conpty",
        } satisfies Pick<Pseudoterminal, "win32Backend">),
      );
      await tick();
      return { host, pty, ready, view };
    }

    it.each([
      ["timeout", "errors.conpty-readiness-timeout"],
      ["unauthenticated", "errors.conpty-control-unauthenticated"],
      ["protocol", "errors.conpty-control-unauthenticated"],
      ["disconnected", "errors.conpty-control-unauthenticated"],
    ] satisfies readonly (readonly [ConPtyControlError["reason"], string])[])(
      "announces a ConPTY %s startup failure exactly once",
      async (reason, key) => {
        const { pty, ready } = await startConPtyView();
        ready.reject(new ConPtyControlError(reason));
        await vi.advanceTimersByTimeAsync(
          TERMINAL_CONPTY_HOST_EXIT_WAIT * library.SI_PREFIX_SCALE,
        );
        await expect(pty.shell).rejects.toMatchObject({ reason });
        await expect(pty.onExit).resolves.toBe("SIGTERM");
        await tick();
        expectExitNotice(key);
      },
    );

    it.each([251, 9009])(
      "announces only the ConPTY startup hint after disconnect and exit %s",
      async (code) => {
        const { host, pty, ready } = await startConPtyView();
        ready.reject(new ConPtyControlError("disconnected"));
        await tick();
        // Emit the native result directly: macOS would truncate exit 9009.
        Object.assign(host, { exitCode: code });
        host.emit("exit", code, null);
        await expect(pty.shell).rejects.toMatchObject({
          reason: "disconnected",
        });
        await expect(pty.onExit).resolves.toBe(code);
        await tick();
        expectExitNotice(`errors.win32-exit-${code.toString()}`);
      },
    );

    it("keeps an intentional ConPTY startup close silent", async () => {
      const { pty, view } = await startConPtyView();
      view.stopEmulator();
      await expect(pty.onExit).resolves.toBe("SIGTERM");
      await expect(pty.shell).rejects.toBeInstanceOf(Error);
      await tick();
      expect(library.notice2).not.toHaveBeenCalled();
    });

    it.each(startupExits)(
      "reports generic exit %s after ConPTY readiness",
      async (code) => {
        const host = spawn(process.execPath, ["-e", ""], { stdio: "pipe" });
        await once(host, "close");
        const exit = Promise.withResolvers<number>();
        await startView(
          Promise.resolve({
            ...pseudoterminal({ win32Backend: "conpty" }),
            shell: Promise.resolve(host),
            onExit: exit.promise,
          }),
        );
        exit.resolve(code);
        await tick();
        expectExitNotice("notices.terminal-exited");
      },
    );

    it.each(startupExits)(
      "keeps the startup hint for ConPTY exit %s before readiness",
      async (code, key) => {
        const exit = Promise.withResolvers<number>(),
          shell =
            Promise.withResolvers<
              Awaited<NonNullable<Pseudoterminal["shell"]>>
            >();
        await startView(
          Promise.resolve({
            ...pseudoterminal({ win32Backend: "conpty" }),
            shell: shell.promise,
            onExit: exit.promise,
          }),
        );
        shell.promise.catch(() => undefined);
        // Exit can arrive before readiness rejection finishes its cleanup.
        exit.resolve(code);
        await tick();
        shell.reject(new Error("host exited before ready"));
        await tick();
        expectExitNotice(key);
      },
    );

    it.each([
      { name: "ConHost", win32Backend: "legacy" },
      { name: "unknown backend", win32Backend: undefined },
      { name: "ConPTY without startup state", win32Backend: "conpty" },
    ] satisfies readonly {
      readonly name: string;
      readonly win32Backend: Pseudoterminal["win32Backend"];
    }[])("reports generic notices for $name", async ({ win32Backend }) => {
      for (const [code] of startupExits) {
        const exit = Promise.withResolvers<number>();
        await startView(
          Promise.resolve({
            ...pseudoterminal({ win32Backend }),
            onExit: exit.promise,
          }),
        );
        exit.resolve(code);
        await tick();
        expectExitNotice("notices.terminal-exited");
        vi.mocked(library.notice2).mockClear();
      }
    });

    it.each(["close", "restart"])(
      "suppresses a startup failure settled after %s",
      async (action) => {
        const exit = Promise.withResolvers<number>(),
          shell =
            Promise.withResolvers<
              Awaited<NonNullable<Pseudoterminal["shell"]>>
            >(),
          view = await startView(
            Promise.resolve({
              ...pseudoterminal({ win32Backend: "conpty" }),
              shell: shell.promise,
              onExit: exit.promise,
            }),
            new Promise<Pseudoterminal>(() => undefined),
          );
        exit.resolve(9009);
        await tick();
        if (action === "close") view.stopEmulator();
        else {
          view.startEmulator(false);
          await tick();
          vi.mocked(library.notice2).mockClear();
        }
        shell.reject(new Error("host exited before ready"));
        await tick();
        expect(library.notice2).not.toHaveBeenCalled();
      },
    );

    it.each(exitCodes)(
      "does not report exit %s after an intentional close",
      async (code) => {
        const exit = Promise.withResolvers<Awaited<Pseudoterminal["onExit"]>>(),
          pty = {
            ...pseudoterminal(),
            kill: vi.fn(() => {
              exit.resolve(code);
            }),
            onExit: exit.promise,
          },
          view = await startView(Promise.resolve(pty));
        view.stopEmulator();
        await tick();
        expect(pty.kill).toHaveBeenCalledOnce();
        expect(library.notice2).not.toHaveBeenCalled();
      },
    );

    it("does not report a terminal closed before its spawn finishes", async () => {
      const spawned = Promise.withResolvers<Pseudoterminal>(),
        exit = Promise.withResolvers<number>(),
        view = await startView(spawned.promise);
      view.stopEmulator();
      spawned.resolve({
        ...pseudoterminal(),
        onExit: exit.promise,
        kill: vi.fn(() => {
          exit.resolve(1);
        }),
      });
      await tick();
      expect(library.notice2).not.toHaveBeenCalled();
    });

    it("does not report the old terminal's exit after restarting", async () => {
      const oldExit = Promise.withResolvers<number>(),
        newExit = Promise.withResolvers<number>(),
        oldPty = {
          ...pseudoterminal(),
          onExit: oldExit.promise,
          kill: vi.fn(() => {
            oldExit.resolve(1);
          }),
        },
        view = await startView(
          Promise.resolve(oldPty),
          Promise.resolve({ ...pseudoterminal(), onExit: newExit.promise }),
        );
      view.startEmulator(false);
      await tick();
      expect(oldPty.kill).toHaveBeenCalledOnce();
      // Restart announces the new spawn but must not announce the old exit.
      expect(library.notice2).toHaveBeenCalledOnce();
      vi.mocked(library.notice2).mockClear();
      newExit.resolve(1);
      await tick();
      expect(library.notice2).toHaveBeenCalledOnce();
    });

    it("keeps reporting actual spawn errors", async () => {
      const spawned = Promise.withResolvers<Pseudoterminal>(),
        error = new Error("spawn failed");
      vi.spyOn(library, "printError").mockImplementation(vi.fn());
      await startView(spawned.promise);
      spawned.reject(error);
      await tick();
      expect(library.printError).toHaveBeenCalledWith(
        error,
        expect.any(Function),
        expect.anything(),
      );
    });

    it.each([
      { state: "closed", reason: "aborted", report: false },
      { state: "replaced", reason: "aborted", report: false },
      { state: "active", reason: "aborted", report: true },
      { state: "closed", reason: "disconnected", report: true },
    ] satisfies readonly {
      readonly state: "closed" | "replaced" | "active";
      readonly reason: ConPtyControlError["reason"];
      readonly report: boolean;
    }[])(
      "handles a $reason startup error from a $state emulator",
      async ({ state, reason, report }) => {
        const spawned = Promise.withResolvers<Pseudoterminal>(),
          error = new ConPtyControlError(reason),
          printError = vi
            .spyOn(library, "printError")
            .mockImplementation(vi.fn()),
          view = await startView(
            spawned.promise,
            Promise.resolve(pseudoterminal()),
          );
        if (state === "closed") view.stopEmulator();
        else if (state === "replaced") {
          view.startEmulator(false);
          await tick();
        }
        spawned.reject(error);
        await tick();
        if (report) {
          expect(printError).toHaveBeenCalledWith(
            error,
            expect.any(Function),
            expect.anything(),
          );
        } else expect(printError).not.toHaveBeenCalled();
      },
    );

    it.each(exitCodes)("reports spontaneous exit %s", async (code) => {
      const exit = Promise.withResolvers<Awaited<Pseudoterminal["onExit"]>>();
      await startView(
        Promise.resolve({ ...pseudoterminal(), onExit: exit.promise }),
      );
      exit.resolve(code);
      await tick();
      expect(library.notice2).toHaveBeenCalledOnce();
    });
  });

  describe("paths dropped on the terminal", () => {
    class TestView extends TerminalView {
      public start(profile: Settings.Profile): void {
        this.state = { ...this.state, profile };
        this.startEmulator(false);
      }
    }
    const integrated = Settings.Profile.DEFAULTS.integrated;

    afterEach(() => {
      platform.windows = false;
    });

    /**
     * Starts a view of a profile on Windows, drops one file from the system
     * on the element of its terminal, and returns what its drag and drop
     * addon pastes, then and later: the addon the view made, of the real
     * class.
     *
     * @param program - the pseudoterminal of the emulator; there by default.
     */
    async function pastesOfDrop(
      profile: Settings.Profile,
      path: string,
      program: Promise<Pseudoterminal> = Promise.resolve({
        ...pseudoterminal(),
        onExit: new Promise<never>(() => {}),
      }),
    ): Promise<readonly (readonly unknown[])[]> {
      platform.windows = true;
      vi.spyOn(console, "debug").mockImplementation(vi.fn());
      vi.spyOn(library, "awaitCSS").mockImplementation(async (element) => {
        Object.assign(element, { onWindowMigrated: vi.fn() });
      });
      vi.spyOn(library, "notice2").mockImplementation(vi.fn());
      vi.spyOn(library, "onResize").mockImplementation(vi.fn());
      vi.spyOn(library, "updateView").mockImplementation(vi.fn());
      vi.spyOn(TerminalView, "EMULATOR").mockImplementation(
        function (_element, _factory, _state, _options, addons) {
          // Only what the view reads of its emulator; the addons are its own.
          return {
            addons,
            close: vi.fn().mockResolvedValue(undefined),
            pseudoterminal: program,
            resize: vi.fn().mockResolvedValue(undefined),
            terminal: {
              unicode: {},
              onWriteParsed: vi.fn(),
              onResize: vi.fn(),
              onTitleChange: vi.fn(),
            },
          } as unknown as TerminalView.EMULATOR;
        },
      );
      const context = {
          app: new App(),
          language: { value: { t: vi.fn((key: string) => key) } },
          settings: { value: Settings.DEFAULT, onMutate: vi.fn() },
        } as unknown as ConstructorParameters<typeof TerminalView>[0],
        paste = vi.fn();
      new TestView(context, new WorkspaceLeaf()).start(profile);
      await vi.waitFor(() => {
        expect(TerminalView.EMULATOR).toHaveBeenCalledOnce();
      });
      const [element, , , , addons] =
        vi.mocked(TerminalView.EMULATOR).mock.calls[0] ?? [];
      if (!element || !addons) throw new Error("Missing emulator arguments");
      // The terminal as the addon uses it: the emulator is not the real one.
      addons.dragAndDrop.activate({
        focus: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onKey: vi.fn(() => ({ dispose: vi.fn() })),
        paste,
      } as unknown as Terminal);

      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", {
        value: { files: [{ name: "file", path }], types: ["Files"] },
      });
      element.dispatchEvent(drop);
      await tick();
      return paste.mock.calls;
    }

    it.each<readonly [string, Settings.Profile, string, readonly string[]]>([
      [
        "the shell of an integrated profile",
        { ...integrated, executable: "powershell.exe" },
        "C:\\Users\\me\\a b.png",
        ["'C:\\Users\\me\\a b.png' "],
      ],
      [
        "the Linux path of a WSL profile",
        { ...integrated, args: ["-d", "Debian"], executable: "wsl.exe" },
        "\\\\wsl.localhost\\Debian\\home\\me\\a.md",
        ["/home/me/a.md "],
      ],
      [
        "the distribution that the arguments of a WSL profile name",
        { ...integrated, args: ["-d", "Ubuntu"], executable: "wsl.exe" },
        "\\\\wsl.localhost\\Debian\\home\\me\\a.md",
        [],
      ],
      [
        "the developer console",
        Settings.Profile.DEFAULTS.developerConsole,
        "C:\\Users\\me\\a b.png",
        ['"C:\\\\Users\\\\me\\\\a b.png" '],
      ],
      [
        "a profile that names no program",
        Settings.Profile.DEFAULTS[""],
        "C:\\Users\\me\\a b.png",
        ['"C:\\Users\\me\\a b.png" '],
      ],
    ])("are written for %s", async (_name, profile, path, pastes) => {
      expect(await pastesOfDrop(profile, path)).toEqual(
        pastes.map((paste) => [paste]),
      );
    });

    // Until then nothing reads what the terminal is given.
    it("are pasted once the emulator has its pseudoterminal, not before", async () => {
      const program = Promise.withResolvers<Pseudoterminal>(),
        pastes = await pastesOfDrop(
          { ...integrated, executable: "powershell.exe" },
          "C:\\Users\\me\\a.png",
          program.promise,
        );

      expect(pastes).toEqual([]);

      program.resolve({
        ...pseudoterminal(),
        onExit: new Promise<never>(() => {}),
      });
      await tick();

      expect(pastes).toEqual([["C:\\Users\\me\\a.png "]]);
    });
  });

  describe("fittedSize", () => {
    const terminal = { cols: 80, rows: 24 };

    it("uses the fit proposal for the pseudoterminal spawn size", () => {
      expect(
        fittedSize(
          { proposeDimensions: () => ({ cols: 132, rows: 43 }) },
          terminal,
        ),
      ).toEqual([132, 43]);
    });

    it("normalizes fractional and zero-cell proposals", () => {
      expect(
        fittedSize(
          { proposeDimensions: () => ({ cols: 100.9, rows: 0.4 }) },
          terminal,
        ),
      ).toEqual([100, 1]);
    });

    it("falls back when the fit proposal is unavailable or invalid", () => {
      expect(fittedSize({ proposeDimensions: () => void 0 }, terminal)).toEqual(
        [80, 24],
      );
      expect(
        fittedSize(
          { proposeDimensions: () => ({ cols: NaN, rows: 10 }) },
          terminal,
        ),
      ).toEqual([80, 24]);
    });

    it("falls back when the fit addon throws", () => {
      expect(
        fittedSize(
          {
            proposeDimensions: () => {
              throw new Error("not opened");
            },
          },
          terminal,
        ),
      ).toEqual([80, 24]);
    });
  });

  describe("settleTerminalBackendOptions", () => {
    const requested = {
      platform: "win32",
      win32Backend: "conpty",
      win32BuildNumber: 19_045,
    } as const;

    it("takes the backend of a ConHost fallback", () => {
      const settled = settleTerminalBackendOptions(
        requested,
        pseudoterminal({ win32Backend: "legacy" }),
      );

      expect(settled).toEqual({ ...requested, win32Backend: "legacy" });
      expect(Object.isFrozen(settled)).toBe(true);
    });

    it("reads a backend exposed through a getter, as a wrapper does", () => {
      class Wrapper implements Pseudoterminal {
        public readonly kill = (): void => {};
        public readonly onExit = Promise.resolve(0);
        public readonly pipe = (): void => {};
        public get win32Backend(): "legacy" {
          return "legacy";
        }
      }

      expect(
        settleTerminalBackendOptions(requested, new Wrapper()).win32Backend,
      ).toBe("legacy");
    });

    it("keeps the request when the pseudoterminal agrees", () => {
      expect(
        settleTerminalBackendOptions(
          requested,
          pseudoterminal({ win32Backend: "conpty" }),
        ),
      ).toBe(requested);
    });

    it("keeps the request when the pseudoterminal names no backend", () => {
      expect(settleTerminalBackendOptions(requested, null)).toBe(requested);
      expect(settleTerminalBackendOptions(requested, pseudoterminal({}))).toBe(
        requested,
      );
      expect(
        settleTerminalBackendOptions(
          requested,
          pseudoterminal({ win32Backend: void 0 }),
        ),
      ).toBe(requested);
    });

    it("stops a later settings change from re-applying the ConPTY hint", () => {
      // The live-update path merges the changed settings with the settled
      // options, not with the profile's request.
      const settled = settleTerminalBackendOptions(
          requested,
          pseudoterminal({ win32Backend: "legacy" }),
        ),
        changed = { documentOverride: null, fontSize: 14 };

      expect(
        mergeTerminalOptions({ documentOverride: null }, changed, requested)
          .windowsPty,
      ).toEqual({ backend: "conpty", buildNumber: 19_045 });
      expect(
        mergeTerminalOptions({ documentOverride: null }, changed, settled)
          .windowsPty,
      ).toBeUndefined();
    });
  });

  describe("TerminalView.State", () => {
    describe("State.DEFAULT", () => {
      it("includes userTitle set to empty string", () => {
        expect(TerminalView.State.DEFAULT).toHaveProperty("userTitle");
        expect(TerminalView.State.DEFAULT.userTitle).toBe("");
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

      it("coerces missing userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
      });

      it("coerces non-string userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: 42,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
      });

      it("coerces boolean userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: true,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
      });

      it("coerces null userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: null,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
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

  describe("getDisplayText", () => {
    it("returns title directly when showTerminalTabPrefix is disabled", async () => {
      const { WorkspaceLeaf } = await import("obsidian");
      const mockI18n = { t: vi.fn((key: string) => key) };
      const mockContext = {
        language: { value: mockI18n },
        settings: { value: { showTerminalTabPrefix: false } },
      } as unknown as ConstructorParameters<typeof TerminalView>[0];
      const leaf = new WorkspaceLeaf();
      const view = new TerminalView(mockContext, leaf);

      const result = view.getDisplayText();
      expect(mockI18n.t).toHaveBeenCalledWith(
        "components.terminal.name.profile-type",
        expect.any(Object),
      );
      expect(result).toBe("components.terminal.name.profile-type");
    });

    it("returns localized display-name when showTerminalTabPrefix is enabled", async () => {
      const { WorkspaceLeaf } = await import("obsidian");
      const mockI18n = { t: vi.fn((key: string) => key) };
      const mockContext = {
        language: { value: mockI18n },
        settings: { value: { showTerminalTabPrefix: true } },
      } as unknown as ConstructorParameters<typeof TerminalView>[0];
      const leaf = new WorkspaceLeaf();
      const view = new TerminalView(mockContext, leaf);

      const result = view.getDisplayText();
      expect(mockI18n.t).toHaveBeenCalledWith(
        "components.terminal.display-name",
        expect.objectContaining({ title: expect.any(String) as unknown }),
      );
      expect(result).toBe("components.terminal.display-name");
    });
  });
});

describe("TerminalView focus", () => {
  // Only the emulator surface that `focus` and the emulator setter touch.
  function makeEmulator(focus = vi.fn()) {
    const emulator = {
      close: vi.fn().mockResolvedValue(undefined),
      terminal: { focus },
    };
    return { emulator: emulator as unknown as TerminalView.EMULATOR, focus };
  }

  function makeBed() {
    const { context, workspace, reveal } = makeTerminalContext();
    const { leaf, view } = makeTerminalLeaf(context);
    const { emulator, focus } = makeEmulator();
    view["emulator"] = emulator;
    return { workspace, reveal, leaf, view, focusTerminal: focus };
  }

  it("asks for the reveal and focuses the terminal without waiting for it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const { reveal, leaf, view, focusTerminal } = makeBed();
    const revealed = deferred();
    reveal.mockReturnValue(revealed.promise);

    view["focus"]();
    // The reveal is still pending and the terminal already has focus.
    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(focusTerminal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledBefore(focusTerminal);

    revealed.resolve(undefined);
    await tick();
    expect(focusTerminal).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("supports a void-returning revealLeaf", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const { workspace, leaf, view, focusTerminal } = makeBed();
    // Obsidian before 1.7.2 returned void from revealLeaf.
    const reveal = vi.fn<() => void>();
    Object.assign(workspace, { revealLeaf: reveal });

    expect(() => {
      view["focus"]();
    }).not.toThrow();

    expect(focusTerminal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    await tick();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs to console.error and still focuses the terminal when revealLeaf rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const { reveal, view, focusTerminal } = makeBed();
    const failure = new Error("reveal failed");
    reveal.mockRejectedValueOnce(failure);

    view["focus"]();

    expect(focusTerminal).toHaveBeenCalledOnce();
    await tick();
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("logs to console.error and still focuses the terminal when revealLeaf throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const { reveal, view, focusTerminal } = makeBed();
    const failure = new Error("reveal failed");
    reveal.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => {
      view["focus"]();
    }).not.toThrow();

    expect(focusTerminal).toHaveBeenCalledOnce();
    await tick();
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("stays quiet when the view unloads before the reveal settles", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const { reveal, view, focusTerminal } = makeBed();
    // `onOpen` registers the cleanup that drops the emulator on unload.
    await view["onOpen"]();
    const revealed = deferred();
    reveal.mockReturnValue(revealed.promise);

    view["focus"]();
    view.unload();
    expect(view["emulator"]).toBeNull();
    revealed.resolve(undefined);
    await tick();

    expect(focusTerminal).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
  });

  describe("through the commands", () => {
    afterEach(() => {
      document.body.replaceChildren();
    });

    it.each(["focus-on-last-terminal", "toggle-focus-on-last-terminal"])(
      "has the terminal focused when %s returns",
      async (id) => {
        const { context, reveal } = makeTerminalContext();
        const addCommand = vi.fn<TerminalPlugin["addCommand"]>(
          (command) => command,
        );
        Object.assign(context, {
          addCommand,
          register: vi.fn(),
          registerEvent: vi.fn(),
          registerView: vi.fn(),
        });
        vi.spyOn(library, "newHotkeyListener").mockReturnValue(vi.fn());
        vi.spyOn(TerminalView["focusedScope"], "register").mockImplementation(
          vi.fn(),
        );
        TerminalView.load(context);
        const { leaf, view } = makeTerminalLeaf(context);
        // `onOpen` makes the view the last focused terminal.
        await view["onOpen"]();
        // A note holds the keyboard; the terminal's textarea can take it.
        const note = document.createElement("textarea");
        const textarea = document.createElement("textarea");
        view.contentEl.append(textarea);
        document.body.append(note, view.contentEl);
        note.focus();
        view["emulator"] = makeEmulator(
          vi.fn(() => {
            textarea.focus();
          }),
        ).emulator;
        // The reveal is still pending when the command returns.
        reveal.mockReturnValue(deferred().promise);
        const command = addCommand.mock.calls
          .map(([registered]) => registered)
          .find((registered) => registered.id === id);

        expect(command?.checkCallback?.(true)).toBe(true);
        command?.checkCallback?.(false);

        expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
        expect(view["isFocused"]).toBe(true);
      },
    );
  });
});

describe("TerminalView.spawn", () => {
  describe.each([true, false])("with focus=%s", (focus) => {
    it.each(Settings.NEW_INSTANCE_BEHAVIORS)(
      "reveals the allocated terminal for %s regardless of focus intent",
      async (newInstanceBehavior) => {
        const { context, workspace, reveal, activate, allocate } =
          makeTerminalContext({
            createInstanceNearExistingOnes: false,
            newInstanceBehavior,
          });
        const main = makeTerminalLeaf(context);
        const left = makeTerminalLeaf(context);
        const right = makeTerminalLeaf(context);
        const target = newInstanceBehavior.startsWith("newLeft")
          ? left
          : newInstanceBehavior.startsWith("newRight")
            ? right
            : main;
        allocate.mockReturnValue(main.leaf);
        vi.spyOn(workspace, "getLeftLeaf").mockReturnValue(left.leaf);
        vi.spyOn(workspace, "getRightLeaf").mockReturnValue(right.leaf);
        vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([target.leaf]);

        await TerminalView.spawn(context, {
          ...TerminalView.State.DEFAULT,
          focus,
        });

        expect(target.setViewState).toHaveBeenCalledOnce();
        expect(reveal).toHaveBeenCalledExactlyOnceWith(target.leaf);
        expect(activate.mock.calls).toEqual(
          focus ? [[target.leaf, { focus: true }]] : [],
        );
      },
    );

    it("uses state.focus when the setting disagrees", async () => {
      const { context, workspace, reveal, activate } = makeTerminalContext({
        focusOnNewInstance: !focus,
      });
      const { leaf } = makeTerminalLeaf(context);
      vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

      await TerminalView.spawn(
        context,
        { ...TerminalView.State.DEFAULT, focus },
        leaf,
      );

      expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
      expect(activate.mock.calls).toEqual(
        focus ? [[leaf, { focus: true }]] : [],
      );
    });
  });

  it("waits for setViewState before revealing and for reveal before activating", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    const stateReady = deferred();
    const revealed = deferred();
    const state = { ...TerminalView.State.DEFAULT, focus: true };
    setViewState.mockReturnValue(stateReady.promise);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    reveal.mockReturnValue(revealed.promise);

    const opening = TerminalView.spawn(context, state, leaf);
    // setState can consume the caller's focus intent before its promise settles.
    state.focus = false;
    expect(setViewState).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();

    stateReady.resolve(undefined);
    await stateReady.promise;
    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();

    revealed.resolve(undefined);
    await opening;
    expect(activate).toHaveBeenCalledExactlyOnceWith(leaf, { focus: true });
  });

  it("reveals without requesting keyboard focus when state.focus is false", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();
    expect(setViewState.mock.calls[0]?.[0]).not.toHaveProperty("active");
  });

  it("activates the revealed terminal without focus when it replaced the active tab", async () => {
    const { context, workspace, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    const active = makeTerminalLeaf(context);
    const parent = {};
    Object.assign(leaf, { parent });
    Object.assign(active.leaf, { parent });
    Object.assign(active.view, {
      containerEl: { offsetParent: null },
    });
    const getActiveViewOfType = vi
      .spyOn(workspace, "getActiveViewOfType")
      .mockReturnValue(active.view);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(activate.mock.calls).toEqual([[leaf]]);
    expect(getActiveViewOfType).toHaveBeenCalledExactlyOnceWith(View);
  });

  it("leaves the active leaf alone when its tab is still shown", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    const active = makeTerminalLeaf(context);
    const parent = {};
    Object.assign(leaf, { parent });
    Object.assign(active.leaf, { parent });
    Object.assign(active.view, {
      containerEl: { offsetParent: document.body },
    });
    vi.spyOn(workspace, "getActiveViewOfType").mockReturnValue(active.view);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();
  });

  it("leaves the active leaf alone when it is in another tab group", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    const active = makeTerminalLeaf(context);
    Object.assign(leaf, { parent: {} });
    Object.assign(active.leaf, { parent: {} });
    Object.assign(active.view, {
      containerEl: { offsetParent: null },
    });
    vi.spyOn(workspace, "getActiveViewOfType").mockReturnValue(active.view);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();
  });

  it("leaves the active leaf alone when no view is active", async () => {
    const { context, workspace, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getActiveViewOfType").mockReturnValue(null);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(activate).not.toHaveBeenCalled();
  });

  it("reveals an explicit destination without allocating another leaf", async () => {
    const { context, workspace, allocate, reveal } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    const left = vi.spyOn(workspace, "getLeftLeaf");
    const right = vi.spyOn(workspace, "getRightLeaf");

    await TerminalView.spawn(context, TerminalView.State.DEFAULT, leaf);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(allocate).not.toHaveBeenCalled();
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
  });

  it("preserves collaborative state and the requested type without active", async () => {
    const { context, workspace, reveal } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    const type = "terminal:custom-view";
    const state = {
      ...TerminalView.State.DEFAULT,
      cwd: "/workspace",
      profile: Settings.Profile.DEFAULTS.integrated,
      profileSourceId: "shell",
      userTitle: "Build",
      focus: true,
    };
    vi.spyOn(workspace, "getLeavesOfType").mockImplementation(
      (requestedType) => (requestedType === type ? [leaf] : []),
    );

    await TerminalView.spawn(context, state, leaf, type);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    const request = setViewState.mock.calls[0]?.[0];
    expect(request).toEqual({
      state: { [TerminalView.type.namespaced(context)]: state },
      type,
    });
    expect(
      readStateCollaboratively(
        TerminalView.type.namespaced(context),
        request?.state,
      ),
    ).toBe(state);
    expect(request).not.toHaveProperty("active");
  });

  it("propagates reveal failure without activating or recording the open", async () => {
    const { context, workspace, next, reveal, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const used = makeTerminalLeaf(context);
    const failed = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      used.leaf,
      failed.leaf,
    ]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, used.leaf);
    const failure = new Error("reveal failed");
    reveal.mockRejectedValueOnce(failure);

    await expect(
      TerminalView.spawn(
        context,
        { ...TerminalView.State.DEFAULT, focus: true },
        failed.leaf,
      ),
    ).rejects.toBe(failure);

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(used.leaf);
  });

  it("propagates setViewState failure without revealing, activating, or recording the open", async () => {
    const { context, workspace, next, allocate, reveal, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const { leaf, setViewState } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    const failure = new Error("setViewState failed");
    setViewState.mockRejectedValueOnce(failure);

    await expect(
      TerminalView.spawn(
        context,
        { ...TerminalView.State.DEFAULT, focus: true },
        leaf,
      ),
    ).rejects.toBe(failure);

    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
  });

  it("skips reveal when setViewState detached the terminal", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    const leaves = vi
      .spyOn(workspace, "getLeavesOfType")
      .mockReturnValue([leaf]);
    setViewState.mockImplementation(() => {
      leaves.mockReturnValue([]);
      return Promise.resolve();
    });

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: true },
      leaf,
    );

    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("skips reveal when setViewState leaves a non-terminal view", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    setViewState.mockImplementation(() => {
      Object.assign(leaf, { view: {} });
      return Promise.resolve();
    });

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: true },
      leaf,
    );

    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("supports a void-returning revealLeaf", async () => {
    const { context, workspace, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    // Obsidian before 1.7.2 returned void from revealLeaf.
    const reveal = vi.fn<() => void>();
    Object.assign(workspace, { revealLeaf: reveal });

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: true },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).toHaveBeenCalledExactlyOnceWith(leaf, { focus: true });
  });
});

describe("TerminalView reveal flash", () => {
  const FLASH = "is-flashing";

  // Obsidian keeps the leaf's tab header in `tabHeaderEl` and flashes it on reveal.
  function makeTabbedLeaf(context: TerminalPlugin) {
    const made = makeTerminalLeaf(context);
    const header = document.createElement("div");
    Object.assign(made.leaf, { tabHeaderEl: header });
    return { ...made, header };
  }

  // Replaces `revealLeaf` with one that flashes the tab as Obsidian does.
  // The returned promise resolves once it has been called.
  function flashOnReveal(
    workspace: App["workspace"],
    header: HTMLElement,
    returnsPromise: boolean,
  ): Promise<undefined> {
    const called = deferred();
    const reveal = vi.fn<() => Promise<void> | undefined>(() => {
      header.classList.add(FLASH);
      called.resolve(undefined);
      return returnsPromise ? Promise.resolve() : undefined;
    });
    Object.assign(workspace, { revealLeaf: reveal });
    return called.promise;
  }

  it("removes the flash from the tab of a terminal it opens", async () => {
    const { context, workspace, reveal } = makeTerminalContext();
    const { leaf, header } = makeTabbedLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    reveal.mockImplementation(() => {
      header.classList.add(FLASH);
      return Promise.resolve();
    });

    await TerminalView.spawn(context, TerminalView.State.DEFAULT, leaf);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(header.classList.contains(FLASH)).toBe(false);
  });

  it("removes the flash from the tab of a terminal it focuses", () => {
    const { context, reveal } = makeTerminalContext();
    const { leaf, view, header } = makeTabbedLeaf(context);
    // The reveal stays pending, as for a view that is still loading.
    reveal.mockImplementation(() => {
      header.classList.add(FLASH);
      return deferred().promise;
    });

    view["focus"]();

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(header.classList.contains(FLASH)).toBe(false);
  });

  describe.each([
    { returns: "a resolved promise", returnsPromise: true },
    // Obsidian before 1.7.2 returned void from revealLeaf.
    { returns: "nothing", returnsPromise: false },
  ])("when revealLeaf returns $returns", ({ returnsPromise }) => {
    it("removes the flash of a terminal it opens before another task runs", async () => {
      const { context, workspace } = makeTerminalContext();
      const { leaf, header } = makeTabbedLeaf(context);
      vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
      const revealed = flashOnReveal(workspace, header, returnsPromise);

      const opened = TerminalView.spawn(
        context,
        TerminalView.State.DEFAULT,
        leaf,
      );
      await revealed;
      await microtasks();

      expect(header.classList.contains(FLASH)).toBe(false);
      await opened;
    });

    it("removes the flash of a terminal it focuses before another task runs", async () => {
      const { context, workspace } = makeTerminalContext();
      const { view, header } = makeTabbedLeaf(context);
      const revealed = flashOnReveal(workspace, header, returnsPromise);

      view["focus"]();
      await revealed;
      await microtasks();

      expect(header.classList.contains(FLASH)).toBe(false);
    });
  });
});

describe("TerminalView.getLeaf session usage", () => {
  it("chooses the last successfully opened terminal instead of traversal order", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
      });
    const first = makeTerminalLeaf(context);
    const second = makeTerminalLeaf(context);
    const hidden = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      first.leaf,
      second.leaf,
      hidden.leaf,
    ]);

    for (const target of [second, first, second]) {
      await TerminalView.spawn(
        context,
        TerminalView.State.DEFAULT,
        target.leaf,
      );
      activate.mockClear();
      allocate.mockClear();

      expect(TerminalView.getLeaf(context)).toBe(next);
      expect(activate).toHaveBeenCalledExactlyOnceWith(target.leaf);
      expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
    }
  });

  it("chooses the last focused terminal", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const first = makeTerminalLeaf(context);
    const second = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      first.leaf,
      second.leaf,
    ]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, first.leaf);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, second.leaf);
    const events = vi.spyOn(first.view, "registerDomEvent");
    await first.view["onOpen"]();
    const focusin = events.mock.calls.find(([, type]) => type === "focusin");
    expect(focusin).toBeDefined();
    focusin?.[2].call(first.view.contentEl, new FocusEvent("focusin"));

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(first.leaf);
  });

  it("uses the next most recently used terminal after the latest closes", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const oldest = makeTerminalLeaf(context);
    const previous = makeTerminalLeaf(context);
    const latest = makeTerminalLeaf(context);
    const unused = makeTerminalLeaf(context);
    const leaves = vi
      .spyOn(workspace, "getLeavesOfType")
      .mockReturnValue([oldest.leaf, previous.leaf, latest.leaf, unused.leaf]);
    for (const target of [oldest, previous, latest]) {
      await TerminalView.spawn(
        context,
        TerminalView.State.DEFAULT,
        target.leaf,
      );
    }
    leaves.mockReturnValue([oldest.leaf, previous.leaf, unused.leaf]);

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(previous.leaf);
  });

  it("uses newInstanceBehavior when terminals exist but none was used this session", () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const unused = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([unused.leaf]);

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not make a terminal an anchor during onOpen", async () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const restored = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([restored.leaf]);

    await restored.view["onOpen"]();

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(activate).not.toHaveBeenCalled();
  });

  it("makes it an anchor once its focusin listener runs", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
      newInstanceBehavior: "newWindow",
    });
    const restored = makeTerminalLeaf(context);
    const unused = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      restored.leaf,
      unused.leaf,
    ]);
    const events = vi.spyOn(restored.view, "registerDomEvent");
    await restored.view["onOpen"]();
    const focusin = events.mock.calls.find(([, type]) => type === "focusin");
    expect(focusin).toBeDefined();
    focusin?.[2].call(restored.view.contentEl, new FocusEvent("focusin"));

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(restored.leaf);
  });

  it("does not inherit usage when a leaf receives a different terminal view", async () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const target = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([target.leaf]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, target.leaf);
    Object.assign(target.leaf, {
      view: new TerminalView(context, target.leaf),
    });

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(activate).not.toHaveBeenCalled();
  });

  it("remembers a revealed open when keyboard focus is disabled", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
      focusOnNewInstance: false,
    });
    const opened = makeTerminalLeaf(context);
    const hidden = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      opened.leaf,
      hidden.leaf,
    ]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      opened.leaf,
    );

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(opened.leaf);
  });

  it("preserves an explicit anchor ahead of session candidates", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const used = makeTerminalLeaf(context);
    const explicit = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([used.leaf]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, used.leaf);

    expect(TerminalView.getLeaf(context, explicit.leaf)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(explicit.leaf);
  });

  it("ignores session candidates when near-existing placement is disabled", async () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: false,
        newInstanceBehavior: "newWindow",
      });
    const used = makeTerminalLeaf(context);
    const leaves = vi
      .spyOn(workspace, "getLeavesOfType")
      .mockReturnValue([used.leaf]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, used.leaf);
    leaves.mockClear();

    expect(TerminalView.getLeaf(context, used.leaf)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(leaves).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  describe.each([true, false])("with pinNewInstance=%s", (pinNewInstance) => {
    describe.each(["Left", "Right"] as const)("in the %s sidebar", (side) => {
      it("preserves pinNewInstance and sidebar null fallbacks", () => {
        const { context, settings, workspace, next, allocate, activate } =
          makeTerminalContext({
            createInstanceNearExistingOnes: true,
            pinNewInstance,
          });
        const anchor = makeTerminalLeaf(context);
        vi.spyOn(anchor.leaf, "getRoot").mockReturnValue(
          side === "Left" ? workspace.leftSplit : workspace.rightSplit,
        );
        const sidebar = vi
          .spyOn(workspace, `get${side}Leaf`)
          .mockReturnValue(next);
        const pin = vi.spyOn(next, "setPinned");

        expect(TerminalView.getLeaf(context, anchor.leaf)).toBe(next);
        expect(sidebar).toHaveBeenCalledExactlyOnceWith(false);
        expect(activate).not.toHaveBeenCalled();
        expect(allocate).not.toHaveBeenCalled();

        sidebar.mockReturnValue(null);
        expect(TerminalView.getLeaf(context, anchor.leaf)).toBe(next);
        expect(activate).toHaveBeenCalledExactlyOnceWith(anchor.leaf);
        expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");

        settings.createInstanceNearExistingOnes = false;
        for (const split of [false, true]) {
          settings.newInstanceBehavior = `new${side}${split ? "Split" : "Tab"}`;
          allocate.mockClear();
          sidebar.mockClear();
          expect(TerminalView.getLeaf(context)).toBe(next);
          expect(sidebar).toHaveBeenCalledExactlyOnceWith(split);
          expect(allocate.mock.calls).toEqual(
            split ? [["split", "horizontal"]] : [["tab"]],
          );
        }
        expect(pin.mock.calls).toEqual(Array(4).fill([pinNewInstance]));
      });
    });
  });
});

// The pane fixture records click callbacks without building Obsidian's menu UI.
function terminalPaneActions(view: TerminalView) {
  const actions = new Map<string, () => unknown>();
  const menu = {
    addSeparator: vi.fn(() => menu),
    addItem: vi.fn((setup: (item: MenuItem) => unknown) => {
      let title = "";
      const item = {
        setTitle: vi.fn((value: string) => {
          title = value;
          return item;
        }),
        setIcon: vi.fn(() => item),
        setDisabled: vi.fn(() => item),
        onClick: vi.fn((callback: () => unknown) => {
          actions.set(title, callback);
          return item;
        }),
      };
      setup(item as unknown as MenuItem);
      return menu;
    }),
  };
  view.onPaneMenu(menu as unknown as Menu, "tab-header");
  return actions;
}

/**
 * Turns the tab status experiment on or off the way a change of the settings
 * reaches its gates: the new value first, then every listener.
 */
function setTabStatus(context: TerminalPlugin, on: boolean): void {
  const { settings } = context,
    enabled = {
      ...Settings.DEFAULT,
      experiments: { tabStatus: true },
    } satisfies Settings;
  Object.assign(settings, {
    value: { ...settings.value, experiments: on ? enabled.experiments : {} },
  });
  // A gate is the listener whose accessor says whether the experiment is on.
  // A copy of the list: a gate that starts adds listeners of its own.
  for (const [accessor, changed] of [
    ...vi.mocked(settings).onMutate.mock.calls,
  ]) {
    if (accessor(Settings.DEFAULT) === false && accessor(enabled) === true) {
      changed(on, !on, settings.value);
    }
  }
}

/**
 * Changes several settings the way one `settings.mutate` announces them: the
 * new value first, then every listener whose accessor reads something else
 * than before, in the order they were registered. The list is the one from
 * before the first call, as the library's emitter takes it: a listener that
 * an earlier one removes still hears of this change.
 */
function mutateSettings(
  context: TerminalPlugin,
  patch: Partial<Settings>,
): void {
  const { settings } = context,
    before = settings.value,
    { calls, results } = vi.mocked(settings).onMutate.mock,
    listening = calls.filter((_call, index) => {
      // What `onMutate` returned removes the listener: not those gone by now.
      const removed = results[index];
      return !(
        removed?.type === "return" &&
        vi.isMockFunction(removed.value) &&
        removed.value.mock.calls.length > 0
      );
    });
  Object.assign(settings, { value: { ...before, ...patch } });
  for (const [accessor, changed] of listening) {
    const prev = accessor(before),
      cur = accessor(settings.value);
    if (!isDeepStrictEqual(cur, prev)) {
      changed(cur, prev, settings.value);
    }
  }
}

describe("program status on the tab, behind its experiment", () => {
  // The test translations answer with the key they were asked for.
  const PLAIN_ICON = "asset:components.terminal.icon",
    ATTRIBUTES = [
      "data-terminal-animation",
      "data-terminal-size",
      "data-terminal-status",
    ];
  interface Handler {
    readonly dispose: ReturnType<typeof vi.fn<() => void>>;
    readonly key: number | string;
    readonly run: (payload: string) => boolean;
  }

  // Animation frames are a hand-driven queue, as in emulator-addons.spec.ts.
  let frames: Map<number, FrameRequestCallback>, nextFrame: number;
  const runFrames = (): void => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number): void => {
      frames.delete(handle);
    });
    vi.mocked(ProgramStatusAddon).mockClear();
    vi.mocked(TabStatusPresenter).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * One terminal, opened as the app opens it: a view on a leaf that has a
   * tab header, and an emulator whose parser keeps what is registered on it.
   * Everything a test asserts about is watched from before the view opens.
   */
  async function openTerminal(experiments: Settings["experiments"] = {}) {
    const { context, workspace } = makeTerminalContext({ experiments }),
      { leaf, view } = makeTerminalLeaf(context),
      header = document.createElement("div"),
      updateHeader = vi.fn<() => void>(),
      registered: Handler[] = [],
      register = (key: Handler["key"], run: Handler["run"]): Handler => {
        const handler: Handler = {
          dispose: vi.fn(() => {
            registered.splice(registered.indexOf(handler), 1);
          }),
          key,
          run,
        };
        registered.push(handler);
        return handler;
      },
      parser = {
        registerEscHandler: vi.fn(
          (id: { readonly final: string }, run: () => boolean) =>
            register(id.final, run),
        ),
        registerOscHandler: vi.fn((ident: number, run: Handler["run"]) =>
          register(ident, run),
        ),
      },
      terminal = {
        element: document.createElement("div"),
        input: vi.fn<(data: string, wasUserInput: boolean) => void>(),
        // As xterm does: loading an addon activates it on the terminal.
        loadAddon: vi.fn(function load(
          this: unknown,
          addon: { readonly activate: (on: unknown) => void },
        ): void {
          addon.activate(this);
        }),
        onResize: vi.fn(),
        onTitleChange: vi.fn(),
        onWriteParsed: vi.fn(),
        parser,
        unicode: {},
      },
      exit = Promise.withResolvers<number>(),
      // Mutable: a test that sets `until` keeps a closing terminal alive.
      closing: { until: Promise<void> | null } = { until: null },
      listen = vi.spyOn(window, "addEventListener"),
      unlisten = vi.spyOn(window, "removeEventListener"),
      follow = vi.fn((_follower: (win: Window) => void) => vi.fn()),
      // The same for the terminal's own element, which the emulator follows.
      moved = vi.fn((_follower: (win: object) => void) => vi.fn()),
      lookedAt = vi
        .spyOn(
          // The getter is protected; a test says whether the user looks.
          view as unknown as { readonly isLookedAt: boolean },
          "isLookedAt",
          "get",
        )
        .mockReturnValue(false),
      count = (spy: typeof listen | typeof unlisten, type: string): number =>
        spy.mock.calls.filter(([name]) => name === type).length;
    Object.assign(leaf, { tabHeaderEl: header, updateHeader });
    Object.assign(workspace, { requestUpdateLayout: vi.fn() });
    Object.assign(view.contentEl, { onWindowMigrated: follow });
    vi.spyOn(library, "awaitCSS").mockImplementation(async (element) => {
      Object.assign(element, { onWindowMigrated: moved });
    });
    vi.spyOn(library, "notice2").mockImplementation(vi.fn());
    vi.spyOn(library, "onResize").mockImplementation(vi.fn());
    vi.spyOn(TerminalView, "EMULATOR").mockImplementation(
      function (_element, _factory, _state, _options, addons) {
        // Only the view-facing surface, as in the exit notices above.
        return {
          addons,
          // As the emulator does: its addons go when the program is gone.
          close: vi.fn(async () => {
            await closing.until;
            addons?.disposer.dispose();
          }),
          pseudoterminal: Promise.resolve({
            ...pseudoterminal(),
            onExit: exit.promise,
          }),
          reopen: vi.fn(),
          resize: vi.fn().mockResolvedValue(undefined),
          terminal,
        } as unknown as TerminalView.EMULATOR;
      },
    );

    await view["onOpen"]();
    view["startEmulator"](false);
    await tick();
    expect(TerminalView.EMULATOR).toHaveBeenCalledOnce();

    return {
      closing,
      context,
      exit,
      follow,
      header,
      lookedAt,
      /**
       * Moves the terminal to another window, as dragging its tab there
       * does: its element is in that window, then whoever follows it hears.
       */
      moveTo: (win: object): void => {
        Object.assign(terminal, {
          element: { ownerDocument: { defaultView: win } },
        });
        moved.mock.calls.forEach(([follower], index) => {
          const unfollow = moved.mock.results[index];
          if (
            unfollow?.type === "return" &&
            unfollow.value.mock.calls.length === 0
          ) {
            follower(win);
          }
        });
      },
      /** Sends an OSC sequence to the terminal; one answer per handler. */
      osc: (ident: number, payload: string): readonly boolean[] =>
        registered
          .filter(({ key }) => key === ident)
          .map(({ run }) => run(payload)),
      parser,
      registered,
      /**
       * What the feature has done and left behind. Asked the same way in
       * every state, so that "nothing" while off is measured with what
       * measures "everything" while on.
       */
      state: () => ({
        addons: vi.mocked(ProgramStatusAddon).mock.calls.length,
        attributes: header
          .getAttributeNames()
          .filter((name) => name.startsWith("data-terminal-"))
          .sort(),
        focusListeners: count(listen, "focus") - count(unlisten, "focus"),
        handlers: registered.map(({ key }) => key),
        icon: view.getIcon(),
        presenters: vi.mocked(TabStatusPresenter).mock.calls.length,
        registrations:
          parser.registerOscHandler.mock.calls.length +
          parser.registerEscHandler.mock.calls.length,
        replies: terminal.input.mock.calls.length,
        terminalFollowers: moved.mock.calls.length,
        windowFollowers: follow.mock.calls.length,
      }),
      terminal,
      updateHeader,
      view,
      workspace,
    };
  }

  /** What `state()` says of a terminal the feature has never touched. */
  const UNTOUCHED = {
      addons: 0,
      attributes: [],
      focusListeners: 0,
      handlers: [],
      icon: PLAIN_ICON,
      presenters: 0,
      registrations: 0,
      replies: 0,
      // The emulator's own, which reopens the terminal in its new window.
      terminalFollowers: 1,
      windowFollowers: 0,
    },
    /** And of one it shows on, before any program has reported. */
    SHOWING = {
      addons: 1,
      attributes: ["data-terminal-animation", "data-terminal-size"],
      focusListeners: 1,
      handlers: [7501, 133, "c"],
      icon: "terminal:tab-bezel",
      presenters: 1,
      registrations: 3,
      replies: 0,
      terminalFollowers: 2,
      windowFollowers: 1,
    };

  it("does nothing while off: no handler, no reply, no listener, no attribute, and the icon of 3.28.0", async () => {
    const opened = await openTerminal(),
      { header, lookedAt, osc, state, view, workspace } = opened;
    expect(state()).toEqual(UNTOUCHED);

    // A program that reports and asks is not heard.
    expect(osc(7501, "state=working")).toEqual([]);
    expect(osc(7501, "?")).toEqual([]);
    expect(osc(133, "A")).toEqual([]);
    // The user comes and goes, the layout changes, the program ends.
    lookedAt.mockReturnValue(true);
    view.contentEl.dispatchEvent(new FocusEvent("focusin"));
    window.dispatchEvent(new Event("focus"));
    workspace.trigger("layout-change");
    opened.exit.resolve(0);
    await tick();
    runFrames();

    expect(state()).toEqual(UNTOUCHED);
    expect(header.getAttributeNames()).toEqual([]);
    expect(frames.size).toBe(0);
    // Nor does anything wait for the look to change.
    expect(
      vi
        .mocked(opened.context.settings)
        .onMutate.mock.calls.filter(([accessor]) =>
          Array.isArray(accessor(Settings.DEFAULT)),
        ),
    ).toEqual([]);
  });

  it("does all of it while on: the handlers, the reply, the listeners, the attributes and the chosen icon", async () => {
    const { context, header, osc, state, terminal } = await openTerminal({
      tabStatus: true,
    });
    expect(state()).toEqual(SHOWING);
    // It is told where to report, and nothing else: it has no switch.
    expect(
      Object.keys(vi.mocked(ProgramStatusAddon).mock.calls[0]?.[0] ?? {}),
    ).toEqual(["onChange"]);
    expect(header.getAttribute("data-terminal-size")).toBe(
      String(context.settings.value.tabIconSize),
    );

    expect(osc(7501, "?")).toEqual([true]);
    expect(terminal.input).toHaveBeenCalledExactlyOnceWith(
      DETECTION_REPLY,
      false,
    );
    expect(osc(7501, "state=working")).toEqual([true]);
    runFrames();
    expect(header.getAttribute("data-terminal-status")).toBe("working");
    expect(header.getAttributeNames().sort()).toEqual(ATTRIBUTES);
  });

  it("starts on an open terminal when turned on, and takes everything back when turned off", async () => {
    const { context, header, osc, registered, state, updateHeader } =
      await openTerminal();
    expect(state()).toEqual(UNTOUCHED);

    setTabStatus(context, true);
    // Applied when the change of the settings has been announced: no frame,
    // no timer and no new terminal is needed.
    expect(state()).toEqual(SHOWING);
    expect(updateHeader).toHaveBeenCalled();
    const handlers = [...registered];
    expect(osc(7501, "state=blocked")).toEqual([true]);
    runFrames();
    expect(header.getAttribute("data-terminal-status")).toBe("blocked");
    // One more report is on its way when the user turns the feature off.
    osc(7501, "state=error");
    expect(frames.size).toBe(1);
    updateHeader.mockClear();

    setTabStatus(context, false);
    expect(frames.size).toBe(0);
    runFrames();
    await tick();
    for (const handler of handlers) {
      expect(handler.dispose).toHaveBeenCalledOnce();
    }
    // As a terminal the feature never touched, but for what was made once.
    expect(state()).toEqual({
      ...UNTOUCHED,
      addons: 1,
      presenters: 1,
      registrations: 3,
      terminalFollowers: 2,
      windowFollowers: 1,
    });
    expect(header.getAttributeNames()).toEqual([]);
    expect(updateHeader).toHaveBeenCalled();
    expect(osc(7501, "state=working")).toEqual([]);
    expect(osc(7501, "?")).toEqual([]);

    // On again: a new start, which knows nothing of what was reported.
    setTabStatus(context, true);
    expect(state()).toEqual({
      ...SHOWING,
      addons: 2,
      presenters: 2,
      registrations: 6,
      terminalFollowers: 3,
      windowFollowers: 2,
    });
    runFrames();
    expect(header.hasAttribute("data-terminal-status")).toBe(false);
  });

  it("follows a change of the look on an open terminal", async () => {
    const { context, header, updateHeader } = await openTerminal({
        tabStatus: true,
      }),
      { settings } = context,
      looks = vi
        .mocked(settings)
        .onMutate.mock.calls.filter(([accessor]) =>
          Array.isArray(accessor(Settings.DEFAULT)),
        );
    expect(looks).toHaveLength(1);
    updateHeader.mockClear();
    Object.assign(settings, {
      value: {
        ...settings.value,
        tabIconSize: 22,
        tabStatusAnimation: "loop",
      },
    });
    looks[0]?.[1]([], [], settings.value);
    expect(header.getAttribute("data-terminal-size")).toBe("22");
    expect(header.getAttribute("data-terminal-animation")).toBe("loop");
    // The icon is Obsidian's to draw again, from `getIcon`.
    expect(updateHeader).toHaveBeenCalledOnce();
  });

  it("writes nothing on an open terminal's tab when the experiment goes off together with a look setting", async () => {
    const { context, header } = await openTerminal({ tabStatus: true });
    mutateSettings(context, { tabIconSize: 22 });
    expect(header.getAttribute("data-terminal-size")).toBe("22");

    // As resetting all settings does: one change turns it off and sets the look.
    mutateSettings(context, { experiments: {}, tabIconSize: 18 });
    expect(header.getAttributeNames()).toEqual([]);
  });

  it("writes nothing for a layout change that is announced while the experiment goes off", async () => {
    const { context, header, workspace } = await openTerminal({
      tabStatus: true,
    });
    // Obsidian calls the listeners an event had when it began: taking one
    // back does not keep it from being called for that event.
    vi.spyOn(workspace, "offref").mockReturnValue();

    setTabStatus(context, false);
    workspace.trigger("layout-change");
    expect(header.getAttributeNames()).toEqual([]);
  });

  it("shows a finish as unread until the user looks, by coming to the terminal or back to its window", async () => {
    const { header, lookedAt, osc, view } = await openTerminal({
        tabStatus: true,
      }),
      status = (): string | null => header.getAttribute("data-terminal-status");
    osc(7501, "state=done");
    runFrames();
    expect(status()).toBe("done");

    // Focus without looking (the window is behind another) changes nothing.
    view.contentEl.dispatchEvent(new FocusEvent("focusin"));
    expect(status()).toBe("done");
    lookedAt.mockReturnValue(true);
    view.contentEl.dispatchEvent(new FocusEvent("focusin"));
    expect(status()).toBe("seen");

    // Looked at while it arrives: seen at once, and the next one is news.
    osc(7501, "state=done");
    runFrames();
    expect(status()).toBe("seen");
    lookedAt.mockReturnValue(false);
    osc(7501, "state=done");
    runFrames();
    expect(status()).toBe("done");
    lookedAt.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(status()).toBe("seen");
  });

  it("drops working when the program ends, and everything when the terminal closes", async () => {
    const { exit, header, osc, registered, state, view } = await openTerminal({
      tabStatus: true,
    });
    osc(7501, "state=working");
    runFrames();
    expect(header.getAttribute("data-terminal-status")).toBe("working");

    exit.resolve(0);
    await tick();
    runFrames();
    expect(header.hasAttribute("data-terminal-status")).toBe(false);

    osc(7501, "state=error");
    runFrames();
    expect(header.getAttribute("data-terminal-status")).toBe("error");
    const handlers = [...registered];
    view.unload();
    await tick();
    // The header belongs to the leaf and outlives the view.
    expect(header.getAttributeNames()).toEqual([]);
    expect(state()).toMatchObject({ focusListeners: 0, handlers: [] });
    for (const handler of handlers) {
      expect(handler.dispose).toHaveBeenCalledOnce();
    }
  });

  it("lets the terminal that replaced another speak for the tab alone", async () => {
    const { closing, header, osc, registered, view } = await openTerminal({
        tabStatus: true,
      }),
      status = (): string | null => header.getAttribute("data-terminal-status"),
      gone = deferred();
    osc(7501, "state=done");
    runFrames();
    expect(status()).toBe("done");
    const [before] = registered;

    // A restart: the new terminal is there before the old program is gone.
    closing.until = gone.promise;
    view["startEmulator"](false);
    await tick();
    expect(registered.map(({ key }) => key)).toEqual([
      ...SHOWING.handlers,
      ...SHOWING.handlers,
    ]);
    // What the program before it reported is not the new one's status.
    expect(status()).toBeNull();
    registered[3]?.run("state=working");
    runFrames();
    expect(status()).toBe("working");

    // The last words of the old program, and its end, change nothing.
    before?.run("state=error");
    runFrames();
    expect(status()).toBe("working");
    gone.resolve(undefined);
    await tick();
    runFrames();
    expect(registered.map(({ key }) => key)).toEqual(SHOWING.handlers);
    expect(status()).toBe("working");
  });

  it("stops following its window when the view closes or the feature is turned off", async () => {
    const { context, follow, view } = await openTerminal({ tabStatus: true }),
      unfollow = (): ReturnType<typeof vi.fn> | undefined => {
        const last = follow.mock.results.at(-1);
        return last?.type === "return" ? last.value : undefined;
      };
    expect(follow).toHaveBeenCalledOnce();
    expect(unfollow()).not.toHaveBeenCalled();
    setTabStatus(context, false);
    expect(unfollow()).toHaveBeenCalledOnce();

    setTabStatus(context, true);
    expect(follow).toHaveBeenCalledTimes(2);
    expect(unfollow()).not.toHaveBeenCalled();
    view.unload();
    expect(unfollow()).toHaveBeenCalledOnce();
  });

  it("takes a status that waits for a frame along when the terminal moves to another window, until the feature is turned off", async () => {
    const { context, header, moveTo, osc } = await openTerminal({
        tabStatus: true,
      }),
      queued: FrameRequestCallback[] = [],
      // A window with frames of its own, as a pop-out or the main window is.
      other = {
        cancelAnimationFrame: vi.fn<(handle: number) => void>(),
        closed: false,
        document: { hidden: false },
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) =>
          queued.push(callback),
        ),
      };
    osc(7501, "state=working");
    expect(frames.size).toBe(1);

    // The tab is dragged to the other window before that frame comes, and
    // the window it left may close without ever running it.
    moveTo(other);
    expect(frames.size).toBe(0);
    for (const callback of queued) callback(0);
    expect(header.getAttribute("data-terminal-status")).toBe("working");

    setTabStatus(context, false);
    moveTo(window);
    expect(other.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});

describe("TerminalView.dressUnloadedTabs", () => {
  /**
   * A tab whose view Obsidian has not loaded yet: the leaf answers to the
   * terminal's type (`getLeavesOfType` is mocked to say so), its header has
   * that type, and its view is not a `TerminalView` but what Obsidian puts
   * in its place, which holds the icon id saved with the layout.
   *
   * @param saved that id, or `null` when the layout has none
   * @param drawn whether its icon is on the tab; an id that is no longer
   *   registered draws nothing
   */
  function unloadedTab(
    saved: string | null = "lucide-terminal",
    drawn = saved !== null,
  ) {
    const leaf = new WorkspaceLeaf(),
      header = document.createElement("div"),
      icon = header
        .appendChild(document.createElement("div"))
        .appendChild(document.createElement("div")),
      view = {
        getIcon(): string {
          return this.icon || "lucide-file";
        },
        icon: saved ?? "",
      };
    header.setAttribute("data-type", "terminal:terminal");
    icon.className = "workspace-tab-header-inner-icon";
    if (saved !== null && drawn) {
      drawIcon(icon, saved);
    }
    Object.assign(leaf, { tabHeaderEl: header, view });
    return { leaf, header, icon, view };
  }

  /**
   * What Obsidian does whenever it updates a tab's header, as when the tab
   * is pinned, linked or moved: it draws the icon its view names.
   */
  function redraw(tab: ReturnType<typeof unloadedTab>): void {
    setIcon(tab.icon, tab.view.getIcon());
  }

  /** Draws an icon as Obsidian does: in place of the one before it, marked with its id. */
  function drawIcon(parent: HTMLElement, id: string): void {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("svg-icon", id);
    parent.replaceChildren(svg);
  }

  afterEach(() => {
    // The mock belongs to the module: what a test made it do would stay.
    vi.mocked(setIcon).mockReset();
  });

  function loadedTab(context: TerminalPlugin) {
    const made = makeTerminalLeaf(context),
      header = document.createElement("div");
    Object.assign(made.leaf, { tabHeaderEl: header });
    return { ...made, header };
  }

  it("writes the chosen size on a tab whose view is not loaded", () => {
    const { context, workspace } = makeTerminalContext({ tabIconSize: 22 }),
      first = unloadedTab(),
      second = unloadedTab(),
      listed = vi
        .spyOn(workspace, "getLeavesOfType")
        .mockReturnValue([first.leaf, second.leaf]);

    TerminalView.dressUnloadedTabs(context, true);

    expect(listed).toHaveBeenCalledExactlyOnceWith(
      TerminalView.type.namespaced(context),
    );
    expect(first.header.getAttribute("data-terminal-size")).toBe("22");
    expect(second.header.getAttribute("data-terminal-size")).toBe("22");
    // The size and no other attribute: the tab shows no status.
    expect(first.header.getAttributeNames()).toEqual([
      "data-type",
      "data-terminal-size",
    ]);
  });

  it("draws the chosen icon on a tab whose view is not loaded", () => {
    const { context, workspace } = makeTerminalContext({ tabIconSet: "tile" }),
      first = unloadedTab(),
      second = unloadedTab(null);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      first.leaf,
      second.leaf,
    ]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(context, true);

    const chosen = tabIconId(context, "tile");
    expect(vi.mocked(setIcon).mock.calls).toEqual([
      [first.icon, chosen],
      [second.icon, chosen],
    ]);
  });

  it("leaves an icon that is already the chosen one", () => {
    const { context, workspace } = makeTerminalContext({ tabIconSet: "tile" }),
      tab = unloadedTab(tabIconId(context, "tile")),
      before = tab.icon.firstElementChild;
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(context, true);

    expect(setIcon).not.toHaveBeenCalled();
    expect(tab.icon.firstElementChild).toBe(before);
  });

  it("draws nothing on a loaded terminal's tab, nor when the size is taken back", () => {
    const { context, workspace } = makeTerminalContext({ tabIconSet: "tile" }),
      loaded = loadedTab(context),
      unloaded = unloadedTab();
    loaded.header
      .appendChild(document.createElement("div"))
      .classList.add("workspace-tab-header-inner-icon");
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      loaded.leaf,
      unloaded.leaf,
    ]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(context, false);
    expect(setIcon).not.toHaveBeenCalled();

    TerminalView.dressUnloadedTabs(context, true);
    // The loaded tab's icon is Obsidian's to draw, from the view's `getIcon`.
    expect(vi.mocked(setIcon).mock.calls).toEqual([
      [unloaded.icon, tabIconId(context, "tile")],
    ]);
  });

  it("writes the size on a header that has no icon element", () => {
    const { context, workspace } = makeTerminalContext({ tabIconSize: 22 }),
      tab = unloadedTab();
    tab.header.replaceChildren();
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockClear();

    expect(() => {
      TerminalView.dressUnloadedTabs(context, true);
      TerminalView.dressUnloadedTabs(context, false);
      TerminalView.dressUnloadedTabs(context, true);
    }).not.toThrow();
    expect(tab.header.getAttribute("data-terminal-size")).toBe("22");
    expect(setIcon).not.toHaveBeenCalled();
  });

  it("leaves a loaded terminal's header to its presenter", () => {
    const { context, workspace } = makeTerminalContext({ tabIconSize: 22 }),
      loaded = loadedTab(context),
      unloaded = unloadedTab();
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      loaded.leaf,
      unloaded.leaf,
    ]);

    TerminalView.dressUnloadedTabs(context, true);
    // Not written here: the view's presenter writes it with the rest.
    expect(loaded.header.getAttributeNames()).toEqual([]);
    expect(unloaded.header.getAttribute("data-terminal-size")).toBe("22");

    // And not taken back here: what the presenter wrote is its own to clear.
    loaded.header.setAttribute("data-terminal-size", "22");
    TerminalView.dressUnloadedTabs(context, false);
    expect(loaded.header.getAttribute("data-terminal-size")).toBe("22");
    expect(unloaded.header.hasAttribute("data-terminal-size")).toBe(false);
  });

  it("takes the size back", () => {
    const { context, workspace } = makeTerminalContext(),
      tab = unloadedTab();
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);

    TerminalView.dressUnloadedTabs(context, true);
    expect(tab.header.getAttribute("data-terminal-size")).toBe(
      String(Settings.DEFAULT.tabIconSize),
    );
    TerminalView.dressUnloadedTabs(context, false);
    expect(tab.header.getAttributeNames()).toEqual(["data-type"]);
  });

  it("skips a leaf that has no tab header", () => {
    const { context, workspace } = makeTerminalContext(),
      bare = new WorkspaceLeaf(),
      tab = unloadedTab();
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([bare, tab.leaf]);

    expect(() => {
      TerminalView.dressUnloadedTabs(context, true);
    }).not.toThrow();
    expect(tab.header.hasAttribute("data-terminal-size")).toBe(true);
    expect(() => {
      TerminalView.dressUnloadedTabs(context, false);
    }).not.toThrow();
    expect(tab.header.hasAttribute("data-terminal-size")).toBe(false);
  });

  it("gives an unloaded tab the 3.28.0 icon back while off", () => {
    const { context, workspace } = makeTerminalContext(),
      // A layout saved while the feature was on names its icon for the tab.
      tab = unloadedTab(tabIconId(context, "bezel"));
    tab.header.setAttribute("data-terminal-size", "18");
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(context, false);

    expect(tab.header.getAttributeNames()).toEqual(["data-type"]);
    // The test translations answer with the key they were asked for.
    expect(vi.mocked(setIcon).mock.calls).toEqual([
      [tab.icon, "asset:components.terminal.icon"],
    ]);
  });

  it("leaves an unloaded tab alone that shows no icon of ours", () => {
    const { context, workspace } = makeTerminalContext(),
      plain = unloadedTab("lucide-terminal"),
      empty = unloadedTab(null),
      before = plain.header.outerHTML;
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      plain.leaf,
      empty.leaf,
    ]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(context, false);

    expect(setIcon).not.toHaveBeenCalled();
    expect(plain.header.outerHTML).toBe(before);
    expect(empty.icon.childElementCount).toBe(0);
  });

  // The test translations answer with the key they were asked for.
  const PLAIN_ICON = "asset:components.terminal.icon";

  it("keeps the 3.28.0 icon on a never-opened tab that Obsidian draws again after the turn-off", () => {
    const { context, workspace } = makeTerminalContext(),
      tab = unloadedTab(tabIconId(context, "bezel"));
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockImplementation(drawIcon);

    TerminalView.dressUnloadedTabs(context, false);
    redraw(tab);

    expect(tab.view.icon).toBe(PLAIN_ICON);
    expect(vi.mocked(setIcon).mock.lastCall).toEqual([tab.icon, PLAIN_ICON]);
  });

  it("keeps the chosen icon on a never-opened tab that Obsidian draws again while on", () => {
    const { context, workspace } = makeTerminalContext(),
      tab = unloadedTab(),
      chosen = tabIconId(context, "bezel");
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockImplementation(drawIcon);

    TerminalView.dressUnloadedTabs(context, true);
    redraw(tab);

    expect(tab.view.icon).toBe(chosen);
    expect(vi.mocked(setIcon).mock.lastCall).toEqual([tab.icon, chosen]);
    // Nothing is written on a tab that already names the chosen icon.
    Object.freeze(tab.view);
    expect(() => {
      TerminalView.dressUnloadedTabs(context, true);
    }).not.toThrow();
  });

  it("gives a never-opened tab its icon back when the saved one is no longer registered", () => {
    const { context, workspace } = makeTerminalContext(),
      tab = unloadedTab("terminal:tab-gone", false);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(context, false);

    expect(tab.view.icon).toBe(PLAIN_ICON);
    expect(vi.mocked(setIcon).mock.calls).toEqual([[tab.icon, PLAIN_ICON]]);
  });

  it("leaves a never-opened tab alone whose saved icon is not the feature's", () => {
    const { context, workspace } = makeTerminalContext(),
      tab = unloadedTab("lucide-file");
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    // Not even written with what it holds: the view is Obsidian's.
    Object.freeze(tab.view);
    vi.mocked(setIcon).mockClear();

    expect(() => {
      TerminalView.dressUnloadedTabs(context, false);
    }).not.toThrow();

    expect(tab.view.icon).toBe("lucide-file");
    expect(setIcon).not.toHaveBeenCalled();
  });

  it("names the right icon also for a never-opened tab whose header cannot be reached", () => {
    const { context, workspace } = makeTerminalContext(),
      saved = unloadedTab(tabIconId(context, "bezel")),
      other = unloadedTab("lucide-file");
    // As on an Obsidian that keeps the tab header under another name.
    Object.assign(saved.leaf, { tabHeaderEl: undefined });
    Object.assign(other.leaf, { tabHeaderEl: undefined });
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      saved.leaf,
      other.leaf,
    ]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(context, false);
    expect(saved.view.icon).toBe(PLAIN_ICON);
    expect(other.view.icon).toBe("lucide-file");

    TerminalView.dressUnloadedTabs(context, true);
    expect(saved.view.icon).toBe(tabIconId(context, "bezel"));
    expect(other.view.icon).toBe(tabIconId(context, "bezel"));
    expect(setIcon).not.toHaveBeenCalled();
  });

  it("follows the experiment when it is not told what to do", () => {
    const off = makeTerminalContext(),
      on = makeTerminalContext({ experiments: { tabStatus: true } }),
      dressed = unloadedTab(tabIconId(off.context, "bezel")),
      bare = unloadedTab();
    dressed.header.setAttribute("data-terminal-size", "18");
    vi.spyOn(off.workspace, "getLeavesOfType").mockReturnValue([dressed.leaf]);
    vi.spyOn(on.workspace, "getLeavesOfType").mockReturnValue([bare.leaf]);
    vi.mocked(setIcon).mockClear();

    TerminalView.dressUnloadedTabs(off.context);
    TerminalView.dressUnloadedTabs(on.context);

    expect(dressed.header.hasAttribute("data-terminal-size")).toBe(false);
    expect(bare.header.getAttribute("data-terminal-size")).toBe(
      String(Settings.DEFAULT.tabIconSize),
    );
    expect(vi.mocked(setIcon).mock.calls).toEqual([
      [dressed.icon, "asset:components.terminal.icon"],
      [bare.icon, tabIconId(on.context, "bezel")],
    ]);
  });

  /** Runs the loader on a context that keeps what it registers. */
  function loadViews(overrides: Partial<Settings> = {}) {
    const made = makeTerminalContext(overrides),
      { context, workspace } = made,
      ready: (() => void)[] = [],
      disposers: (() => void)[] = [],
      on = vi.spyOn(workspace, "on"),
      offref = vi.spyOn(workspace, "offref"),
      // The spy is typed by one overload of `on`; any name is a word here.
      layoutChange: string = "layout-change",
      layoutListeners = (): number =>
        on.mock.calls.filter(([name]) => name === layoutChange).length -
        offref.mock.calls.length;
    Object.assign(workspace, {
      onLayoutReady: vi.fn((callback: () => void) => {
        ready.push(callback);
      }),
    });
    Object.assign(context, {
      addCommand: vi.fn((command: object) => command),
      displayName: vi.fn(() => "Terminal"),
      register: vi.fn((dispose: () => void) => {
        disposers.push(dispose);
      }),
      registerEvent: vi.fn(),
      registerView: vi.fn(),
    });
    // The rest of the loader registers commands and a key handler; the
    // shared mocks have no hotkey manager and no handler-less scope.
    vi.spyOn(library, "newHotkeyListener").mockReturnValue(vi.fn());
    vi.spyOn(TerminalView["focusedScope"], "register").mockReturnValue({
      key: null,
      modifiers: null,
      scope: TerminalView["focusedScope"],
    });
    vi.spyOn(TerminalView["focusedScope"], "unregister").mockReturnValue();
    TerminalView.load(context);
    return { ...made, disposers, layoutListeners, ready };
  }

  it("listens for layout changes and for the look only while on", () => {
    const { context, disposers, layoutListeners, ready, workspace } = loadViews(
        { tabIconSize: 20 },
      ),
      tab = unloadedTab(),
      size = (): string | null => tab.header.getAttribute("data-terminal-size"),
      changed = {
        ...Settings.DEFAULT,
        tabIconSet: "tile",
        tabIconSize: 23,
      } satisfies Settings,
      // The listeners of the look, by what their accessors read.
      looks = (): number =>
        vi.mocked(context.settings).onMutate.mock.calls.filter(([accessor]) => {
          const read = accessor(changed);
          return read === "tile" || read === 23;
        }).length;
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockClear();

    // Off: one pass when the layout is ready, and nothing that listens.
    for (const callback of ready) callback();
    expect(layoutListeners()).toBe(0);
    expect(looks()).toBe(0);
    workspace.trigger("layout-change");
    expect(tab.header.getAttributeNames()).toEqual(["data-type"]);
    expect(setIcon).not.toHaveBeenCalled();

    setTabStatus(context, true);
    expect(size()).toBe("20");
    expect(layoutListeners()).toBe(1);
    expect(looks()).toBe(2);

    setTabStatus(context, false);
    expect(size()).toBeNull();
    expect(layoutListeners()).toBe(0);
    vi.mocked(setIcon).mockClear();
    workspace.trigger("layout-change");
    expect(size()).toBeNull();
    expect(setIcon).not.toHaveBeenCalled();

    // Unloading while off has nothing left to take back.
    for (const dispose of disposers) dispose();
    expect(tab.header.getAttributeNames()).toEqual(["data-type"]);
  });

  it("leaves a never-opened tab plain when the experiment goes off together with a look setting", () => {
    const { context, ready, workspace } = loadViews({
        experiments: { tabStatus: true },
        tabIconSize: 22,
      }),
      tab = unloadedTab(tabIconId(context, "bezel"));
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([tab.leaf]);
    vi.mocked(setIcon).mockImplementation(drawIcon);
    for (const callback of ready) callback();
    expect(tab.header.getAttribute("data-terminal-size")).toBe("22");

    // As resetting all settings does: one change turns it off and sets the look.
    mutateSettings(context, { experiments: {}, tabIconSize: 18 });

    // The test translations answer with the key they were asked for.
    expect(vi.mocked(setIcon).mock.lastCall).toEqual([
      tab.icon,
      "asset:components.terminal.icon",
    ]);
    expect(tab.header.getAttributeNames()).toEqual(["data-type"]);
  });

  it("goes over the tabs when the layout is ready, when it changes and when the size or the icon set does, until the plugin unloads", () => {
    const { context, disposers, ready, workspace } = loadViews({
        experiments: { tabStatus: true },
        tabIconSize: 20,
      }),
      tab = unloadedTab(),
      later = unloadedTab(),
      listed = vi
        .spyOn(workspace, "getLeavesOfType")
        .mockReturnValue([tab.leaf]),
      size = (header: Element): string | null =>
        header.getAttribute("data-terminal-size");

    // Nothing before the layout is there: there are no tabs to go over yet.
    expect(size(tab.header)).toBeNull();
    for (const callback of ready) callback();
    expect(size(tab.header)).toBe("20");

    // A tab that arrives later, unloaded as well.
    listed.mockReturnValue([tab.leaf, later.leaf]);
    workspace.trigger("layout-change");
    expect(size(later.header)).toBe("20");

    // Another size: the listener registered for that setting, and only it.
    const probe = { ...Settings.DEFAULT, tabIconSize: 23 } satisfies Settings,
      onSize = vi
        .mocked(context.settings)
        .onMutate.mock.calls.filter(([accessor]) => accessor(probe) === 23);
    expect(onSize).toHaveLength(1);
    Object.assign(context.settings, {
      value: { ...context.settings.value, tabIconSize: 14 },
    });
    onSize[0]?.[1](14, 20, context.settings.value);
    expect(size(tab.header)).toBe("14");
    expect(size(later.header)).toBe("14");

    // Another icon set: its own listener, and the tabs get the new icon.
    const onSet = vi
      .mocked(context.settings)
      .onMutate.mock.calls.filter(
        ([accessor]) =>
          accessor({ ...probe, tabIconSet: "tile" } satisfies Settings) ===
          "tile",
      );
    expect(onSet).toHaveLength(1);
    Object.assign(context.settings, {
      value: { ...context.settings.value, tabIconSet: "tile" },
    });
    vi.mocked(setIcon).mockClear();
    onSet[0]?.[1]("tile", "bezel", context.settings.value);
    expect(vi.mocked(setIcon).mock.calls).toEqual([
      [tab.icon, tabIconId(context, "tile")],
      [later.icon, tabIconId(context, "tile")],
    ]);

    // Unload takes the size back, and a late layout-ready writes nothing.
    for (const dispose of disposers) dispose();
    expect(size(tab.header)).toBeNull();
    expect(size(later.header)).toBeNull();
    for (const callback of ready) callback();
    expect(size(tab.header)).toBeNull();
  });
});

describe("TerminalView pane menu", () => {
  describe.each([false, true])("with source focus=%s", (sourceFocus) => {
    it("copy passes the current focus setting without mutating the source state", async () => {
      const { context, settings } = makeTerminalContext({
        focusOnNewInstance: sourceFocus,
      });
      const source = makeTerminalLeaf(context);
      const target = makeTerminalLeaf(context);
      const sourceState = Object.freeze({
        ...TerminalView.State.DEFAULT,
        focus: sourceFocus,
        cwd: "/workspace",
        userTitle: "Source",
      });
      Object.defineProperty(source.view, "state", { value: sourceState });
      const allocate = vi
        .spyOn(TerminalView, "getLeaf")
        .mockReturnValue(target.leaf);
      const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue();
      const actions = terminalPaneActions(source.view);
      settings.focusOnNewInstance = !sourceFocus;

      await actions.get("components.terminal.menus.copy")?.();

      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        context,
        { ...sourceState, focus: !sourceFocus },
        target.leaf,
        source.view.getViewType(),
      );
      expect(allocate).toHaveBeenCalledExactlyOnceWith(context, source.leaf);
    });
  });

  it("edit keeps its existing focus intent", async () => {
    const { context } = makeTerminalContext({ focusOnNewInstance: true });
    const { leaf, view } = makeTerminalLeaf(context);
    const sourceState = Object.freeze({
      ...TerminalView.State.DEFAULT,
      focus: false,
      userTitle: "Source",
    });
    Object.defineProperty(view, "state", { value: sourceState });
    const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue();
    const confirmations: Promise<void>[] = [];
    vi.spyOn(EditTerminalModal.prototype, "open").mockImplementation(function (
      this: EditTerminalModal,
    ) {
      confirmations.push(this["confirm"](vi.fn()));
    });

    terminalPaneActions(view).get("components.terminal.menus.edit")?.();
    await Promise.all(confirmations);

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      context,
      sourceState,
      leaf,
      view.getViewType(),
    );
  });
});

describe("TerminalView file link leaf", () => {
  function makeBed() {
    const { context, workspace, next, allocate } = makeTerminalContext();
    const terminal = makeTerminalLeaf(context);
    const note = new WorkspaceLeaf();
    const notes: WorkspaceLeaf[] = [];
    const empties: WorkspaceLeaf[] = [];
    const leaves = new Map([
      ["markdown", notes],
      ["empty", empties],
      [TerminalView.type.namespaced(context), [terminal.leaf]],
    ]);
    // Real Obsidian lists leaves by the type of the view they host now.
    vi.spyOn(workspace, "getLeavesOfType").mockImplementation(
      (type) => leaves.get(type) ?? [],
    );
    const lastActive = (leaf: WorkspaceLeaf): void => {
      TerminalView["lastActiveOtherLeaf"] = new WeakRef(leaf);
    };
    const lastActiveNote = (leaf: WorkspaceLeaf): void => {
      TerminalView["lastActiveNoteLeaf"] = new WeakRef(leaf);
    };
    // A leaf's parent is its tab group. Obsidian hides the tabs that are not
    // in front, and a hidden element has no offset parent.
    const place = (leaf: WorkspaceLeaf, tabs: object, shown = true): void => {
      Object.assign(leaf, { parent: tabs });
      Object.assign(leaf.view, {
        containerEl: { offsetParent: shown ? document.body : null },
      });
    };
    // A pop-out window is another container; only its identity matters.
    const moveToWindow = (leaf: WorkspaceLeaf, container: object): void => {
      Object.assign(leaf, { getContainer: () => container });
    };
    const viewType = (leaf: WorkspaceLeaf, type: string): void => {
      Object.assign(leaf.view, {
        getViewType: vi.fn().mockReturnValue(type),
        leaf,
      });
    };
    const pin = (leaf: WorkspaceLeaf): void => {
      vi.spyOn(leaf, "getViewState").mockReturnValue({
        pinned: true,
        state: {},
        type: "markdown",
      });
    };
    // Registers the workspace handlers of the plugin, as its start does.
    const load = (): void => {
      Object.assign(context, {
        addCommand: vi.fn<TerminalPlugin["addCommand"]>((command) => command),
        register: vi.fn(),
        registerEvent: vi.fn(),
        registerView: vi.fn(),
      });
      vi.spyOn(library, "newHotkeyListener").mockReturnValue(vi.fn());
      vi.spyOn(TerminalView["focusedScope"], "register").mockImplementation(
        vi.fn(),
      );
      TerminalView.load(context);
    };
    return {
      context,
      workspace,
      terminal,
      note,
      notes,
      empties,
      lastActive,
      lastActiveNote,
      place,
      moveToWindow,
      viewType,
      pin,
      load,
      next,
      allocate,
    };
  }

  afterEach(() => {
    TerminalView["lastActiveOtherLeaf"] = null;
    TerminalView["lastActiveNoteLeaf"] = null;
  });

  it("reuses the last active note", () => {
    const { terminal, note, notes, lastActive, allocate } = makeBed();
    notes.push(note);
    lastActive(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(note);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("reuses the last active note when a non-note leaf was active after it", () => {
    const { terminal, note, notes, lastActive, lastActiveNote, allocate } =
      makeBed();
    notes.push(note);
    lastActiveNote(note);
    lastActive(new WorkspaceLeaf());

    expect(terminal.view["fileLinkLeaf"]()).toBe(note);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("prefers the last other leaf when it now hosts a note", () => {
    const { terminal, note, notes, lastActive, lastActiveNote, allocate } =
      makeBed();
    const other = new WorkspaceLeaf();
    lastActiveNote(note);
    lastActive(other);
    notes.push(note, other);

    expect(terminal.view["fileLinkLeaf"]()).toBe(other);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("opens a new tab when the remembered note is pinned", () => {
    const {
      terminal,
      note,
      notes,
      lastActive,
      lastActiveNote,
      pin,
      next,
      allocate,
    } = makeBed();
    notes.push(note);
    lastActiveNote(note);
    lastActive(new WorkspaceLeaf());
    pin(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("opens a new tab when the remembered note was closed", () => {
    const { terminal, note, lastActive, lastActiveNote, next, allocate } =
      makeBed();
    lastActiveNote(note);
    lastActive(new WorkspaceLeaf());

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("remembers only non-terminal markdown leaves as the last active note", () => {
    const { workspace, terminal, note, viewType, load } = makeBed();
    viewType(note, "markdown");
    const other = new WorkspaceLeaf();
    viewType(other, "file-explorer");
    load();

    workspace.trigger("active-leaf-change", note);
    expect(TerminalView["lastActiveOtherLeaf"]?.deref()).toBe(note);
    expect(TerminalView["lastActiveNoteLeaf"]?.deref()).toBe(note);

    workspace.trigger("active-leaf-change", other);
    expect(TerminalView["lastActiveOtherLeaf"]?.deref()).toBe(other);
    expect(TerminalView["lastActiveNoteLeaf"]?.deref()).toBe(note);

    workspace.trigger("active-leaf-change", terminal.leaf);
    expect(TerminalView["lastActiveOtherLeaf"]?.deref()).toBe(other);
    expect(TerminalView["lastActiveNoteLeaf"]?.deref()).toBe(note);
  });

  it("opens a clicked file in the note used before a sidebar pane and the terminal", () => {
    const { workspace, terminal, note, notes, viewType, load, allocate } =
      makeBed();
    viewType(note, "markdown");
    notes.push(note);
    const explorer = new WorkspaceLeaf();
    viewType(explorer, "file-explorer");
    load();

    workspace.trigger("active-leaf-change", note);
    workspace.trigger("active-leaf-change", explorer);
    workspace.trigger("active-leaf-change", terminal.leaf);

    expect(terminal.view["fileLinkLeaf"]()).toBe(note);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("opens a clicked file in the note that was active when the plugin loaded", () => {
    // Enabling or updating the plugin in a running app fires no event for it.
    const { workspace, terminal, note, notes, viewType, load, allocate } =
      makeBed();
    viewType(note, "markdown");
    notes.push(note);
    vi.spyOn(workspace, "getActiveViewOfType").mockReturnValue(note.view);
    load();

    expect(terminal.view["fileLinkLeaf"]()).toBe(note);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("reuses a note shown in another tab group when none is remembered", () => {
    // As after a restart with the terminal focused: no other leaf was active.
    const { terminal, note, notes, place, allocate } = makeBed();
    place(terminal.leaf, {});
    place(note, {});
    notes.push(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(note);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("reuses an empty tab shown in another tab group when no note is", () => {
    const { terminal, note, notes, empties, place, allocate } = makeBed();
    const empty = new WorkspaceLeaf();
    place(terminal.leaf, {});
    place(note, {}, false);
    place(empty, {});
    notes.push(note);
    empties.push(empty);

    expect(terminal.view["fileLinkLeaf"]()).toBe(empty);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("prefers a shown note to a shown empty tab", () => {
    const { terminal, note, notes, empties, place } = makeBed();
    const empty = new WorkspaceLeaf();
    place(terminal.leaf, {});
    place(empty, {});
    place(note, {});
    empties.push(empty);
    notes.push(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(note);
  });

  it("opens a new tab when the only other note is behind another tab", () => {
    const { terminal, note, notes, place, next, allocate } = makeBed();
    place(terminal.leaf, {});
    place(note, {}, false);
    notes.push(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("opens a new tab when the only other note shares the terminal's tab group", () => {
    // Stacked tabs show every leaf of the group at once.
    const { terminal, note, notes, place, next, allocate } = makeBed();
    const tabs = {};
    place(terminal.leaf, tabs);
    place(note, tabs);
    notes.push(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("opens a new tab when the only shown note is pinned", () => {
    const { terminal, note, notes, place, pin, next, allocate } = makeBed();
    place(terminal.leaf, {});
    place(note, {});
    notes.push(note);
    pin(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it.each(["left", "right"] as const)(
    "opens a new tab when the only shown note is in the %s sidebar",
    (side) => {
      // A note kept in a sidebar is reused only after it was the active leaf.
      const { workspace, terminal, note, notes, place, next, allocate } =
        makeBed();
      place(terminal.leaf, {});
      place(note, {});
      notes.push(note);
      vi.spyOn(note, "getRoot").mockReturnValue(workspace[`${side}Split`]);

      expect(terminal.view["fileLinkLeaf"]()).toBe(next);
      expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
    },
  );

  it("opens a new tab when the remembered note is in another window", () => {
    // Revealing a leaf raises its window, here over the terminal's own.
    const { terminal, note, notes, lastActive, moveToWindow, next, allocate } =
      makeBed();
    notes.push(note);
    lastActive(note);
    moveToWindow(terminal.leaf, {});

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("reuses the remembered note of the pop-out window the terminal is in", () => {
    const { terminal, note, notes, lastActive, moveToWindow, allocate } =
      makeBed();
    const popout = {};
    notes.push(note);
    lastActive(note);
    moveToWindow(terminal.leaf, popout);
    moveToWindow(note, popout);

    expect(terminal.view["fileLinkLeaf"]()).toBe(note);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("opens a new tab when the only shown note is in another window", () => {
    const { terminal, note, notes, place, moveToWindow, next, allocate } =
      makeBed();
    place(terminal.leaf, {});
    place(note, {});
    notes.push(note);
    moveToWindow(note, {});

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("opens a new tab when no other leaf was active", () => {
    const { terminal, next, allocate } = makeBed();

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("opens a new tab when the last other leaf now hosts this terminal", () => {
    // "Replace tab" turns the previously active empty leaf into the terminal.
    const { terminal, lastActive, next, allocate } = makeBed();
    lastActive(terminal.leaf);

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("opens a new tab when the last active note was closed", () => {
    const { terminal, note, lastActive, next, allocate } = makeBed();
    lastActive(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });

  it("opens a new tab instead of replacing a pinned note", () => {
    const { terminal, note, notes, lastActive, pin, next, allocate } =
      makeBed();
    notes.push(note);
    pin(note);
    lastActive(note);

    expect(terminal.view["fileLinkLeaf"]()).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
  });
});
