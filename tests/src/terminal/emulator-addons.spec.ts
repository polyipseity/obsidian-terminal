/**
 * Unit tests for `CustomKeyEventHandlerAddon` in `src/terminal/emulator-addons.ts`.
 *
 * Covers:
 * - Option+printable character passthrough (macOS xterm bug #2831 workaround)
 * - Option+non-character keys (arrows, function keys, Enter) now pass through
 *   to xterm when no keymapping matches — the old suppression was a bug
 * - Keymapping actions including the new "passthrough" action
 * - Shift+Enter ESC+CR injection via default keymapping (not hardcoded)
 * - Guard conditions (disposed, platform, setting, modifier combos)
 * - Win32 input mode (DECSET 9001): KEY_EVENT_RECORD encoding, dead-key
 *   composition deferred to the browser, layout-aware virtual keys
 * - SynchronizedOutputScrollAddon: scroll position preservation across DEC 2026
 *   synchronized output blocks via queueMicrotask (xterm.js issue #5801 workaround)
 * - DragAndDropAddon: vault drags (read from Obsidian's drag manager), files
 *   from the system and lists of file URIs (VS Code's own list first) pasted
 *   as absolute paths, one paste per drop (one per path on Windows) and drop
 *   after drop, written for the profile's shell by the real
 *   `dropped-paths.ts`; drags without a usable path, or without one that can
 *   be written for the shell, refused, reported or left untouched
 */
import type { ILink, ILinkProvider, IDisposable, Terminal } from "@xterm/xterm";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { App, TFile, Vault, Workspace, WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter, Platform as ObsidianPlatform } from "obsidian";
import {
  type PluginContext,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import { noop } from "ts-essentials";
import type { Settings } from "../../../src/settings-data.js";
import {
  CustomKeyEventHandlerAddon,
  DragAndDropAddon,
  FollowThemeAddon,
  SynchronizedOutputScrollAddon,
  VaultFileLinksAddon,
} from "../../../src/terminal/emulator-addons.js";
import { tick } from "../../support/helpers.js";

/** What `DragAndDropAddon` reads of the result of `stat`. */
interface DragAndDropStats {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}

/** What `DragAndDropAddon` reads from module state, set per test. */
interface DragAndDropEnvironment {
  /** Whether `electron` can be required; `false` as on mobile. */
  electron: boolean;
  /** Whether `node:fs/promises` can be required. */
  fileSystem: boolean;
  /** `notice2` of the library: one mock for every copy of the module. */
  readonly notice2: Mock;
  /** Overrides `Platform.CURRENT`; `null` keeps the real one. */
  platform: string | null;
  /** `stat` of `node:fs/promises`, which checks the paths of a URI list. */
  readonly stat: Mock<(path: string) => Promise<DragAndDropStats>>;
  /** Electron's `webUtils`; `undefined` as in Electron before 30. */
  webUtils: { readonly getPathForFile: (file: File) => string } | undefined;
}
const dragAndDropEnvironment = vi.hoisted((): DragAndDropEnvironment => ({
  electron: true,
  fileSystem: true,
  notice2: vi.fn(),
  platform: null,
  stat: vi.fn<(path: string) => Promise<DragAndDropStats>>(),
  webUtils: void 0,
}));

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
        return dragAndDropEnvironment.platform ?? actual.Platform.CURRENT;
      },
    },
    notice2: dragAndDropEnvironment.notice2,
  };
});

/*
 * `emulator-addons.ts` requires `electron` and `node:fs/promises` once, when
 * the module loads, through the `BUNDLE` map of `src/imports.js`. Entries for
 * them stand in for Electron and the file system; `webUtils` is read at each
 * drop and `stat` is one mock, so tests can change both. Whether a module can
 * be required at all is read when it is required: a test that takes one away
 * loads its own copy of `emulator-addons.ts`.
 */
vi.mock("../../../src/imports.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/imports.js")>();
  return {
    ...actual,
    BUNDLE: new Map([
      ...actual.BUNDLE,
      [
        "electron",
        (): unknown => {
          if (!dragAndDropEnvironment.electron) {
            throw new Error("Cannot find module 'electron'");
          }
          return {
            get webUtils() {
              return dragAndDropEnvironment.webUtils;
            },
          };
        },
      ],
      [
        "node:fs/promises",
        (): unknown => {
          if (!dragAndDropEnvironment.fileSystem) {
            throw new Error("Cannot find module 'node:fs/promises'");
          }
          return { stat: dragAndDropEnvironment.stat };
        },
      ],
    ]),
  };
});

/** Minimal mock Terminal with `input()` and `attachCustomKeyEventHandler()`. */
function createMockTerminal() {
  const inputSpy = vi.fn();
  let handler: ((event: KeyboardEvent) => boolean) | null = null;
  const csiHandlers: Record<
    string,
    Array<(params: (number | number[])[]) => boolean>
  > = {};

  const terminal = {
    input: inputSpy,
    attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) {
      handler = fn;
    },
    element: document.createElement("div"),
    parser: {
      registerCsiHandler(
        id: { prefix?: string; final: string },
        callback: (params: (number | number[])[]) => boolean,
      ): IDisposable {
        const key = `${id.prefix ?? ""}${id.final}`;
        const bucket = (csiHandlers[key] ??= []);
        bucket.push(callback);
        return {
          dispose: vi.fn(() => {
            const index = bucket.indexOf(callback);
            if (index >= 0) {
              bucket.splice(index, 1);
            }
          }),
        };
      },
    },
  } as unknown as Terminal;

  return {
    terminal: terminal,
    inputSpy,
    getHandler: () => {
      if (!handler) {
        throw new Error("Handler not registered");
      }
      return handler;
    },
    triggerCsi: (prefix: string, final: string, params: number[]) =>
      (csiHandlers[`${prefix}${final}`] ?? []).map((callback) =>
        callback(params),
      ),
  };
}

/** Create a synthetic KeyboardEvent-like object. */
function fakeKeyEvent(
  overrides: Partial<KeyboardEvent> & { key: string },
): KeyboardEvent {
  return {
    type: "keydown",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    getModifierState: vi.fn().mockReturnValue(false),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

/** The built-in Shift+Enter → ESC CR mapping (platform-agnostic default). */
const SHIFT_ENTER_MAPPING: Settings.Keymapping = {
  action: "sendEscapeSequence",
  actionArg: "\r",
  alt: false,
  ctrl: false,
  key: "Enter",
  meta: false,
  platform: null,
  shift: true,
};

describe("CustomKeyEventHandlerAddon", () => {
  let inputSpy: ReturnType<typeof vi.fn>;
  let handler: (event: KeyboardEvent) => boolean;
  let triggerCsi: (
    prefix: string,
    final: string,
    params: number[],
  ) => boolean[];

  /** Helper: activate addon with passthrough enabled and return handler. */
  function setupWin32InputMode(
    getMappings: () => readonly Settings.Keymapping[] = () => [],
  ) {
    return setup(false, getMappings, "win32", () => true);
  }

  function setup(
    isEnabled = true,
    getMappings: () => readonly Settings.Keymapping[] = () => [],
    currentPlatform = "darwin",
    supportsWin32InputMode: () => boolean = () => false,
  ) {
    const mock = createMockTerminal();
    inputSpy = mock.inputSpy;
    const addon = new CustomKeyEventHandlerAddon(
      currentPlatform,
      getMappings,
      () => isEnabled,
      supportsWin32InputMode,
    );
    addon.activate(mock.terminal);
    handler = mock.getHandler();
    triggerCsi = mock.triggerCsi;
    return addon;
  }

  beforeEach(() => {
    setup();
  });

  // === Option+printable passthrough ===

  it("injects composed character on Option+printable", () => {
    const result = handler(fakeKeyEvent({ key: "@", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("@");
  });

  it("suppresses keyup to prevent duplicate character emission", () => {
    const result = handler(
      fakeKeyEvent({ key: "@", altKey: true, type: "keyup" }),
    );
    expect(result).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  // === Option+non-character keys pass through when no mapping matches ===
  // These were previously suppressed (a bug: non-char Option+keys like arrows
  // and function keys are not affected by xterm bug #2831 and should reach
  // xterm normally when no keymapping covers them).

  it("passes through Option+Left to xterm when no mapping matches", () => {
    const result = handler(fakeKeyEvent({ key: "ArrowLeft", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("passes through Option+Right to xterm when no mapping matches", () => {
    const result = handler(fakeKeyEvent({ key: "ArrowRight", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  // === Windows ConPTY input mode backport ===

  it("encodes Backspace after DECSET 9001 on supported ConPTY terminals", () => {
    setupWin32InputMode();

    expect(triggerCsi("?", "h", [9001])).toEqual([false]);
    expect(handler(fakeKeyEvent({ code: "Backspace", key: "Backspace" }))).toBe(
      false,
    );
    expect(inputSpy).toHaveBeenCalledWith("\x1b[8;14;8;1;0;1_", true);
  });

  it("encodes keyup while Win32 input mode is active", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(
      handler(
        fakeKeyEvent({
          code: "KeyA",
          key: "a",
          type: "keyup",
        }),
      ),
    ).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1b[65;30;97;0;0;1_", true);
  });

  it.each([
    { code: "ShiftLeft", key: "Shift", keyCode: 16 },
    { code: "ControlLeft", key: "Control", keyCode: 17 },
    { code: "AltLeft", key: "Alt", keyCode: 18 },
    { code: "AltRight", key: "AltGraph", keyCode: 18 },
    { code: "MetaLeft", key: "Meta", keyCode: 91 },
  ])(
    "marks $key-only Win32 records as non-user input",
    ({ code, key, keyCode }) => {
      setupWin32InputMode();
      triggerCsi("?", "h", [9001]);

      expect(handler(fakeKeyEvent({ code, key, keyCode }))).toBe(false);
      expect(inputSpy).toHaveBeenCalledWith(expect.any(String), false);
    },
  );

  it("suppresses keypress without emitting a duplicate Win32 record", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(
      handler(fakeKeyEvent({ code: "KeyA", key: "a", type: "keypress" })),
    ).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("stops encoding after DECRST 9001", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(triggerCsi("?", "l", [9001])).toEqual([false]);
    expect(handler(fakeKeyEvent({ code: "Backspace", key: "Backspace" }))).toBe(
      true,
    );
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("does not activate for unrelated CSI private modes", () => {
    setupWin32InputMode();

    expect(triggerCsi("?", "h", [1049])).toEqual([false]);
    expect(handler(fakeKeyEvent({ code: "Backspace", key: "Backspace" }))).toBe(
      true,
    );
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("does not register mode handlers off Windows", () => {
    setup(
      false,
      () => [],
      "darwin",
      () => true,
    );

    expect(triggerCsi("?", "h", [9001])).toEqual([]);
    expect(triggerCsi("?", "l", [9001])).toEqual([]);
  });

  // A ConHost fallback is known only after the terminal opened, so the
  // backend is asked when the mode is requested.

  it("ignores DECSET 9001 once the backend is not ConPTY", () => {
    let conpty = true;
    setup(
      false,
      () => [],
      "win32",
      () => conpty,
    );
    conpty = false;

    expect(triggerCsi("?", "h", [9001])).toEqual([false]);
    expect(handler(fakeKeyEvent({ code: "Backspace", key: "Backspace" }))).toBe(
      true,
    );
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("honours DECSET 9001 once the backend is ConPTY", () => {
    let conpty = false;
    setup(
      false,
      () => [],
      "win32",
      () => conpty,
    );
    conpty = true;

    expect(triggerCsi("?", "h", [9001])).toEqual([false]);
    expect(handler(fakeKeyEvent({ code: "Backspace", key: "Backspace" }))).toBe(
      false,
    );
    expect(inputSpy).toHaveBeenCalledWith("\x1b[8;14;8;1;0;1_", true);
  });

  it("keeps user keymappings ahead of active Win32 input mode", () => {
    setup(
      false,
      () => [
        {
          action: "sendText",
          actionArg: "mapped",
          alt: false,
          ctrl: false,
          key: "Backspace",
          meta: false,
          platform: null,
          shift: false,
        },
      ],
      "win32",
      () => true,
    );
    triggerCsi("?", "h", [9001]);

    expect(handler(fakeKeyEvent({ code: "Backspace", key: "Backspace" }))).toBe(
      false,
    );
    expect(inputSpy).toHaveBeenCalledOnce();
    expect(inputSpy).toHaveBeenCalledWith("mapped");
  });

  it("routes a matched passthrough mapping into active Win32 encoding", () => {
    setup(
      false,
      () => [
        {
          action: "passthrough",
          actionArg: null,
          alt: false,
          ctrl: false,
          key: "Backspace",
          meta: false,
          platform: null,
          shift: false,
        },
      ],
      "win32",
      () => true,
    );
    triggerCsi("?", "h", [9001]);

    expect(handler(fakeKeyEvent({ code: "Backspace", key: "Backspace" }))).toBe(
      false,
    );
    expect(inputSpy).toHaveBeenCalledWith("\x1b[8;14;8;1;0;1_", true);
  });

  // === Dead keys in Win32 input mode ===
  // Chromium on Windows composes dead keys itself: the composed character
  // arrives on the keypress of the key that follows the dead key.

  const DEAD_QUOTE = { code: "Quote", key: "Dead", keyCode: 222 };

  /** Runs the handler on one event and reports whether it was cancelled. */
  function dispatch(overrides: Partial<KeyboardEvent> & { key: string }): {
    cancelled: boolean;
    result: boolean;
  } {
    const preventDefault = vi.fn();
    const result = handler(fakeKeyEvent({ ...overrides, preventDefault }));
    return { cancelled: preventDefault.mock.calls.length > 0, result };
  }

  it("leaves a dead key's keydown to the browser", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(dispatch(DEAD_QUOTE)).toEqual({ cancelled: false, result: false });
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("encodes the dead key's keyup", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);

    expect(dispatch({ ...DEAD_QUOTE, type: "keyup" })).toEqual({
      cancelled: true,
      result: false,
    });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[222;40;0;0;0;1_",
      true,
    );
  });

  it("defers the key combined with a dead key to its keypress", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);

    expect(dispatch({ code: "KeyE", key: "e", keyCode: 69 })).toEqual({
      cancelled: false,
      result: false,
    });
    expect(inputSpy).not.toHaveBeenCalled();

    // A keypress's `keyCode` is its character, never the virtual key.
    expect(
      dispatch({ code: "KeyE", key: "é", keyCode: 233, type: "keypress" }),
    ).toEqual({ cancelled: true, result: false });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[69;18;233;1;0;1_",
      true,
    );
  });

  it("keeps the layout's virtual key across composition", () => {
    // QWERTZ: the `z` key sits at the `KeyY` position and reports `VK_Z`;
    // the composed keypress reports its character instead.
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);
    dispatch({ code: "KeyY", key: "z", keyCode: 90 });

    dispatch({ code: "KeyY", key: "ź", keyCode: 378, type: "keypress" });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[90;21;378;1;0;1_",
      true,
    );
  });

  it("encodes a doubled dead key with the dead key's own virtual key", () => {
    // `'` `'` yields `'` on US-International: the keypress follows the second
    // dead keydown with no character keydown in between.
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);
    dispatch({ ...DEAD_QUOTE, type: "keyup" });
    inputSpy.mockClear();
    dispatch(DEAD_QUOTE);

    dispatch({ code: "Quote", key: "'", keyCode: 39, type: "keypress" });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[222;40;39;1;0;1_",
      true,
    );
  });

  it("encodes every character the browser composes from one keydown", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);
    dispatch({ code: "KeyQ", key: "q", keyCode: 81 });

    dispatch({ code: "KeyQ", key: "'", keyCode: 39, type: "keypress" });
    dispatch({ code: "KeyQ", key: "q", keyCode: 113, type: "keypress" });
    expect(inputSpy.mock.calls).toEqual([
      ["\x1b[81;16;39;1;0;1_", true],
      ["\x1b[81;16;113;1;0;1_", true],
    ]);
  });

  it("delivers a dead key released by Space, then encodes the next key", () => {
    // xterm.js #3573: the arrow after `'` + Space must not be swallowed.
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);
    dispatch({ code: "Space", key: " ", keyCode: 32 });
    dispatch({ code: "Space", key: "'", keyCode: 39, type: "keypress" });

    expect(
      dispatch({ code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 }),
    ).toEqual({ cancelled: true, result: false });
    expect(inputSpy.mock.calls).toEqual([
      ["\x1b[32;57;39;1;0;1_", true],
      ["\x1b[37;75;0;1;256;1_", true],
    ]);
  });

  it("keeps the dead key pending across a modifier keydown", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);

    expect(
      dispatch({
        code: "ShiftLeft",
        key: "Shift",
        keyCode: 16,
        shiftKey: true,
      }),
    ).toEqual({ cancelled: true, result: false });
    expect(
      dispatch({ code: "KeyE", key: "E", keyCode: 69, shiftKey: true }),
    ).toEqual({ cancelled: false, result: false });
    dispatch({
      code: "KeyE",
      key: "É",
      keyCode: 201,
      shiftKey: true,
      type: "keypress",
    });
    expect(inputSpy.mock.calls).toEqual([
      ["\x1b[16;42;0;1;16;1_", false],
      ["\x1b[69;18;201;1;16;1_", true],
    ]);
  });

  it("does not defer a chord after a dead key", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);

    expect(
      dispatch({ code: "KeyC", ctrlKey: true, key: "c", keyCode: 67 }),
    ).toEqual({ cancelled: true, result: false });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[67;46;3;1;8;1_",
      true,
    );
  });

  it("cancels keydowns again once the composed character arrived", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);
    dispatch({ code: "KeyE", key: "e", keyCode: 69 });
    dispatch({ code: "KeyE", key: "é", keyCode: 233, type: "keypress" });
    inputSpy.mockClear();

    expect(dispatch({ code: "KeyA", key: "a", keyCode: 65 })).toEqual({
      cancelled: true,
      result: false,
    });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[65;30;97;1;0;1_",
      true,
    );
    expect(
      dispatch({ code: "KeyA", key: "a", keyCode: 97, type: "keypress" }),
    ).toEqual({ cancelled: true, result: false });
    expect(inputSpy).toHaveBeenCalledTimes(1);
  });

  it("forgets a pending dead key when the mode ends", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(DEAD_QUOTE);
    triggerCsi("?", "l", [9001]);
    triggerCsi("?", "h", [9001]);

    expect(dispatch({ code: "KeyE", key: "e", keyCode: 69 })).toEqual({
      cancelled: true,
      result: false,
    });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[69;18;101;1;0;1_",
      true,
    );
  });

  it("passes IME composition through while Win32 input mode is active", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(
      handler(fakeKeyEvent({ code: "KeyA", isComposing: true, key: "a" })),
    ).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("leaves the keydown that starts an IME composition to the IME", () => {
    // Chromium fires it with `isComposing` false, `keyCode` 229, and the key
    // `Process`; a record for it would precede the composed text.
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(dispatch({ code: "KeyA", key: "Process", keyCode: 229 })).toEqual({
      cancelled: false,
      result: true,
    });
    expect(
      dispatch({ code: "KeyA", key: "Process", keyCode: 229, type: "keyup" }),
    ).toEqual({ cancelled: false, result: true });
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("encodes the composed `å`, whose keypress has keyCode 229", () => {
    const deadRing = { code: "BracketLeft", key: "Dead", keyCode: 221 };
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch(deadRing);
    dispatch({ code: "KeyA", key: "a", keyCode: 65 });

    expect(
      dispatch({ code: "KeyA", key: "å", keyCode: 229, type: "keypress" }),
    ).toEqual({ cancelled: true, result: false });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[65;30;229;1;0;1_",
      true,
    );
  });

  describe("Alt+Numpad composition", () => {
    const alt = { altKey: true, code: "AltLeft", key: "Alt", keyCode: 18 },
      digit = { altKey: true, code: "Numpad0", key: "0", keyCode: 96 },
      character = { code: "AltLeft", key: "é", keyCode: 233, type: "keypress" };

    it.each(
      [
        { numLock: false, releaseFirst: false },
        { numLock: false, releaseFirst: true },
        { numLock: true, releaseFirst: false },
        { numLock: true, releaseFirst: true },
      ].flatMap((scenario) =>
        ["Alt", "é"].map((releaseKey) => ({ ...scenario, releaseKey })),
      ),
    )(
      "delivers Alt+0233 once (NumLock=$numLock, release first=$releaseFirst, release key=$releaseKey)",
      ({ numLock, releaseFirst, releaseKey }) => {
        setupWin32InputMode();
        triggerCsi("?", "h", [9001]);
        const getModifierState = vi.fn(
          (modifier: string) => modifier === "NumLock" && numLock,
        );
        expect(dispatch({ ...alt, getModifierState })).toEqual({
          cancelled: false,
          result: false,
        });
        for (const key of "0233") {
          for (const type of ["keydown", "keyup"]) {
            expect(
              dispatch({
                altKey: true,
                code: `Numpad${key}`,
                getModifierState,
                key,
                keyCode: 96 + Number(key),
                type,
              }),
            ).toEqual({ cancelled: false, result: false });
          }
        }
        const release = {
          ...alt,
          altKey: false,
          getModifierState,
          key: releaseKey,
          type: "keyup",
        };
        if (releaseFirst) {
          expect(dispatch(release)).toEqual({
            cancelled: false,
            result: false,
          });
        }
        expect(dispatch({ ...character, getModifierState })).toEqual({
          cancelled: true,
          result: false,
        });
        if (!releaseFirst) {
          dispatch(release);
        }
        // A duplicate character event must not insert a second character.
        expect(dispatch({ ...character, getModifierState })).toEqual({
          cancelled: true,
          result: false,
        });
        const locks = numLock ? 32 : 0,
          altDown = [`\x1b[18;56;0;1;${String(locks | 2)};1_`, false],
          altUp = [`\x1b[18;56;0;0;${String(locks)};1_`, false],
          composed = [
            `\x1b[0;0;233;1;${String(locks)};1_\x1b[0;0;233;0;${String(locks)};1_`,
            true,
          ];
        expect(inputSpy.mock.calls).toEqual(
          releaseFirst
            ? [altDown, altUp, composed]
            : [altDown, composed, altUp],
        );
      },
    );

    it("uses the OS character and only its lock state, even before the last digit's keyup", () => {
      setupWin32InputMode();
      triggerCsi("?", "h", [9001]);
      dispatch(alt);
      dispatch(digit);
      dispatch({ ...alt, altKey: false, type: "keyup" });
      inputSpy.mockClear();

      dispatch({
        ...character,
        key: "€",
        keyCode: 8364,
        altKey: true,
        ctrlKey: true,
        shiftKey: true,
        metaKey: true,
        getModifierState: vi.fn().mockReturnValue(true),
      });
      dispatch({ ...digit, altKey: false, type: "keyup" });
      dispatch(character);
      expect(inputSpy.mock.calls).toEqual([
        ["\x1b[0;0;8364;1;224;1_\x1b[0;0;8364;0;224;1_", true],
      ]);
    });

    it.each(
      [
        "unrelated keydown",
        "mapped keydown",
        "IME composition",
        "IME start",
        "DECRST",
        "disposal",
      ].flatMap((interruption) =>
        [false, true].map((releaseFirst) => ({ interruption, releaseFirst })),
      ),
    )(
      "forgets a composition after $interruption (released=$releaseFirst)",
      ({ interruption, releaseFirst }) => {
        const addon = setupWin32InputMode(() => [SHIFT_ENTER_MAPPING]);
        triggerCsi("?", "h", [9001]);
        dispatch(alt);
        dispatch(digit);
        if (releaseFirst) {
          dispatch({ ...alt, altKey: false, type: "keyup" });
        }

        switch (interruption) {
          case "unrelated keydown":
            dispatch({ code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 });
            break;
          case "mapped keydown":
            dispatch({
              code: "Enter",
              key: "Enter",
              keyCode: 13,
              shiftKey: true,
            });
            expect(inputSpy).toHaveBeenLastCalledWith("\x1b\r");
            break;
          case "IME composition":
            expect(dispatch({ key: "Process", isComposing: true })).toEqual({
              cancelled: false,
              result: true,
            });
            break;
          case "IME start":
            expect(dispatch({ key: "Process", keyCode: 229 })).toEqual({
              cancelled: false,
              result: true,
            });
            break;
          case "DECRST":
            triggerCsi("?", "l", [9001]);
            triggerCsi("?", "h", [9001]);
            break;
          case "disposal": {
            addon.dispose();
            expect(dispatch(character)).toEqual({
              cancelled: false,
              result: true,
            });
            // Reactivate the same addon to verify disposal cleared its state.
            const mock = createMockTerminal();
            addon.activate(mock.terminal);
            handler = mock.getHandler();
            inputSpy = mock.inputSpy;
            triggerCsi = mock.triggerCsi;
            triggerCsi("?", "h", [9001]);
            break;
          }
        }
        inputSpy.mockClear();
        const reset = interruption === "DECRST" || interruption === "disposal";
        expect(dispatch({ ...digit, altKey: false, type: "keyup" })).toEqual({
          cancelled: reset,
          result: false,
        });
        // An interrupted digit still has no matching down record. A mode
        // reset, however, must forget even the held-key suppression state.
        expect(inputSpy.mock.calls).toEqual(
          reset ? [["\x1b[96;82;48;0;0;1_", true]] : [],
        );
        inputSpy.mockClear();
        dispatch(character);
        expect(inputSpy).not.toHaveBeenCalled();
        dispatch({ code: "KeyA", key: "a", keyCode: 65 });
        expect(inputSpy.mock.calls).toEqual([["\x1b[65;30;97;1;0;1_", true]]);
      },
    );

    it.each([
      { ctrlKey: true },
      { shiftKey: true },
      { metaKey: true },
      {
        getModifierState: vi.fn((modifier: string) => modifier === "AltGraph"),
      },
    ])(
      "does not compose a numpad chord with extra modifiers: %j",
      (modifiers) => {
        setupWin32InputMode();
        triggerCsi("?", "h", [9001]);
        dispatch(alt);
        inputSpy.mockClear();
        expect(dispatch({ ...digit, ...modifiers })).toEqual({
          cancelled: true,
          result: false,
        });
        expect(inputSpy).toHaveBeenCalledOnce();
        inputSpy.mockClear();
        dispatch(character);
        expect(inputSpy).not.toHaveBeenCalled();
      },
    );

    it("keeps ordinary Alt shortcuts and subsequent numpad chords encoded", () => {
      setupWin32InputMode();
      triggerCsi("?", "h", [9001]);
      dispatch(alt);
      const shortcut = { altKey: true, code: "KeyF", key: "f", keyCode: 70 };
      expect(dispatch(shortcut)).toEqual({ cancelled: true, result: false });
      dispatch({ ...shortcut, type: "keyup" });
      dispatch(digit);
      dispatch({ ...digit, type: "keyup" });
      dispatch({ ...alt, altKey: false, type: "keyup" });
      dispatch(character);
      expect(inputSpy.mock.calls).toEqual([
        ["\x1b[18;56;0;1;2;1_", false],
        ["\x1b[70;33;102;1;2;1_", true],
        ["\x1b[70;33;102;0;2;1_", true],
        ["\x1b[96;82;48;1;2;1_", true],
        ["\x1b[96;82;48;0;2;1_", true],
        ["\x1b[18;56;0;0;0;1_", false],
      ]);
    });
  });

  // === Clipboard chords in Win32 input mode ===
  // xterm.js has no key for these, so the browser copies or pastes. No default
  // keymapping binds them either.

  const CLIPBOARD_CHORDS = [
    {
      chord: { code: "Insert", key: "Insert", keyCode: 45, shiftKey: true },
      name: "Shift+Insert",
    },
    {
      chord: { code: "Insert", ctrlKey: true, key: "Insert", keyCode: 45 },
      name: "Ctrl+Insert",
    },
    {
      chord: {
        code: "KeyV",
        ctrlKey: true,
        key: "V",
        keyCode: 86,
        shiftKey: true,
      },
      name: "Ctrl+Shift+V",
    },
    {
      chord: {
        code: "KeyC",
        ctrlKey: true,
        key: "C",
        keyCode: 67,
        shiftKey: true,
      },
      name: "Ctrl+Shift+C",
    },
  ];

  it.each(CLIPBOARD_CHORDS)("leaves $name to the browser", ({ chord }) => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(dispatch(chord)).toEqual({ cancelled: false, result: true });
    // Key repeat.
    expect(dispatch(chord)).toEqual({ cancelled: false, result: true });
    expect(dispatch({ ...chord, type: "keyup" })).toEqual({
      cancelled: false,
      result: true,
    });
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it.each(CLIPBOARD_CHORDS)(
    "sends no keyup for $name after its modifiers were released",
    ({ chord }) => {
      setupWin32InputMode();
      triggerCsi("?", "h", [9001]);
      dispatch(chord);

      expect(
        dispatch({
          ...chord,
          ctrlKey: false,
          key: chord.key.toLowerCase(),
          shiftKey: false,
          type: "keyup",
        }),
      ).toEqual({ cancelled: false, result: true });
      expect(inputSpy).not.toHaveBeenCalled();
    },
  );

  it("encodes the modifiers around a clipboard chord", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    const control = {
        code: "ControlLeft",
        ctrlKey: true,
        key: "Control",
        keyCode: 17,
      },
      shift = {
        code: "ShiftLeft",
        ctrlKey: true,
        key: "Shift",
        keyCode: 16,
        shiftKey: true,
      };

    dispatch(control);
    dispatch(shift);
    dispatch({
      code: "KeyV",
      ctrlKey: true,
      key: "V",
      keyCode: 86,
      shiftKey: true,
    });
    dispatch({ ...shift, shiftKey: false, type: "keyup" });
    dispatch({ ...control, ctrlKey: false, type: "keyup" });

    expect(inputSpy.mock.calls).toEqual([
      ["\x1b[17;29;0;1;8;1_", false],
      ["\x1b[16;42;0;1;24;1_", false],
      ["\x1b[16;42;0;0;8;1_", false],
      ["\x1b[17;29;0;0;0;1_", false],
    ]);
  });

  it("still encodes a plain V, its keyup, and other chords", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(dispatch({ code: "KeyV", key: "v", keyCode: 86 })).toEqual({
      cancelled: true,
      result: false,
    });
    expect(
      dispatch({ code: "KeyV", key: "v", keyCode: 86, type: "keyup" }),
    ).toEqual({ cancelled: true, result: false });
    dispatch({ code: "KeyV", ctrlKey: true, key: "v", keyCode: 86 });
    dispatch({ code: "Insert", key: "Insert", keyCode: 45 });
    dispatch({
      code: "Insert",
      ctrlKey: true,
      key: "Insert",
      keyCode: 45,
      shiftKey: true,
    });
    dispatch({
      altKey: true,
      code: "KeyV",
      ctrlKey: true,
      key: "V",
      keyCode: 86,
      shiftKey: true,
    });

    expect(inputSpy.mock.calls).toEqual([
      ["\x1b[86;47;118;1;0;1_", true],
      ["\x1b[86;47;118;0;0;1_", true],
      ["\x1b[86;47;22;1;8;1_", true],
      ["\x1b[45;82;0;1;256;1_", true],
      ["\x1b[45;82;0;1;280;1_", true],
      ["\x1b[86;47;0;1;26;1_", true],
    ]);
  });

  it("encodes the keyup of a key that went down again outside a chord", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    const chord = {
      code: "KeyV",
      ctrlKey: true,
      key: "V",
      keyCode: 86,
      shiftKey: true,
    };
    dispatch(chord);
    // The keyup was lost, for example to a focus change.
    dispatch({ code: "KeyV", key: "v", keyCode: 86 });
    inputSpy.mockClear();

    expect(
      dispatch({ code: "KeyV", key: "v", keyCode: 86, type: "keyup" }),
    ).toEqual({ cancelled: true, result: false });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[86;47;118;0;0;1_",
      true,
    );
  });

  it("follows the layout's virtual key for a clipboard chord", () => {
    // Russian layout: the `V` position types `м` and still reports `VK_V`.
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);

    expect(
      dispatch({
        code: "KeyV",
        ctrlKey: true,
        key: "М",
        keyCode: 86,
        shiftKey: true,
      }),
    ).toEqual({ cancelled: false, result: true });
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("forgets a passed-through chord when the mode ends", () => {
    setupWin32InputMode();
    triggerCsi("?", "h", [9001]);
    dispatch({
      code: "KeyV",
      ctrlKey: true,
      key: "V",
      keyCode: 86,
      shiftKey: true,
    });
    triggerCsi("?", "l", [9001]);
    triggerCsi("?", "h", [9001]);

    expect(
      dispatch({ code: "KeyV", key: "v", keyCode: 86, type: "keyup" }),
    ).toEqual({ cancelled: true, result: false });
    expect(inputSpy).toHaveBeenCalledExactlyOnceWith(
      "\x1b[86;47;118;0;0;1_",
      true,
    );
  });

  it("passes through Option+Backspace to xterm when no mapping matches", () => {
    const result = handler(fakeKeyEvent({ key: "Backspace", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("passes through Option+Delete to xterm when no mapping matches", () => {
    const result = handler(fakeKeyEvent({ key: "Delete", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("passes through Option+F5 to xterm when no mapping matches", () => {
    // Regression guard: non-character function keys were incorrectly suppressed
    // before the Stage 2 passthrough bug fix.
    const result = handler(fakeKeyEvent({ key: "F5", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  // === Guard conditions ===

  it("passes through dead keys (incomplete composition) to xterm", () => {
    // Dead keys produce key.length > 1; they are not single-char composition
    // events so the passthrough stage does not intercept them.
    const result = handler(fakeKeyEvent({ key: "Dead", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("passes through Option+Enter to xterm (not a character composition event)", () => {
    const result = handler(fakeKeyEvent({ key: "Enter", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("skips Option handling when passthrough is disabled", () => {
    setup(false);
    const result = handler(fakeKeyEvent({ key: "@", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("skips interception when Ctrl or Meta is held", () => {
    const ctrlResult = handler(
      fakeKeyEvent({ key: "l", altKey: true, ctrlKey: true }),
    );
    const metaResult = handler(
      fakeKeyEvent({ key: "l", altKey: true, metaKey: true }),
    );
    expect(ctrlResult).toBe(true);
    expect(metaResult).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("suppresses Option key alone to prevent stray bare ESC", () => {
    const result = handler(fakeKeyEvent({ key: "Alt", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  // === Keymapping actions ===

  it("'ignore' action suppresses the event and sends nothing", () => {
    setup(false, () => [
      {
        key: "a",
        alt: false,
        ctrl: true,
        meta: false,
        shift: false,
        platform: null,
        action: "ignore",
        actionArg: null,
      },
    ]);
    const result = handler(fakeKeyEvent({ key: "a", ctrlKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("'passthrough' action yields to xterm (returns true) for both keydown and keyup", () => {
    setup(false, () => [
      {
        key: "a",
        alt: false,
        ctrl: true,
        meta: false,
        shift: false,
        platform: null,
        action: "passthrough",
        actionArg: null,
      },
    ]);
    const keydownResult = handler(fakeKeyEvent({ key: "a", ctrlKey: true }));
    const keyupResult = handler(
      fakeKeyEvent({ key: "a", ctrlKey: true, type: "keyup" }),
    );
    expect(keydownResult).toBe(true);
    expect(keyupResult).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("'sendEscapeSequence' action sends ESC+arg and suppresses the event", () => {
    setup(false, () => [
      {
        key: "b",
        alt: true,
        ctrl: false,
        meta: false,
        shift: false,
        platform: null,
        action: "sendEscapeSequence",
        actionArg: "b",
      },
    ]);
    const result = handler(fakeKeyEvent({ key: "b", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1bb");
  });

  // === Shift+Enter (now provided via keymapping, not hardcoded) ===

  it("Shift+Enter sends ESC+CR when the default mapping is provided", () => {
    // Passthrough disabled; Shift+Enter is handled by the mapping in Stage 1.
    setup(false, () => [SHIFT_ENTER_MAPPING]);
    const result = handler(fakeKeyEvent({ key: "Enter", shiftKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1b\r");
  });

  it("Shift+Enter keyup is suppressed when the default mapping is provided", () => {
    setup(false, () => [SHIFT_ENTER_MAPPING]);
    const result = handler(
      fakeKeyEvent({ key: "Enter", shiftKey: true, type: "keyup" }),
    );
    expect(result).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("Shift+Enter passes through when no mapping is configured", () => {
    // With no keymappings and passthrough disabled, Shift+Enter is not handled
    // by either stage and falls through to xterm.
    setup(false);
    const result = handler(fakeKeyEvent({ key: "Enter", shiftKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  // === Platform filtering ===

  it("platform-specific mapping fires on matching platform", () => {
    setup(
      false,
      () => [
        {
          key: "a",
          alt: false,
          ctrl: true,
          meta: false,
          shift: false,
          platform: "darwin",
          action: "sendHexCode",
          actionArg: "01",
        },
      ],
      "darwin",
    );
    const result = handler(fakeKeyEvent({ key: "a", ctrlKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x01");
  });

  it("platform-specific mapping is skipped on a different platform", () => {
    setup(
      false,
      () => [
        {
          key: "a",
          alt: false,
          ctrl: true,
          meta: false,
          shift: false,
          platform: "darwin",
          action: "sendHexCode",
          actionArg: "01",
        },
      ],
      "linux",
    );
    const result = handler(fakeKeyEvent({ key: "a", ctrlKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  // === Disposal ===

  it("returns true (no-op) after dispose()", () => {
    const addon = setup();
    addon.dispose();
    const result = handler(fakeKeyEvent({ key: "@", altKey: true }));
    expect(result).toBe(true);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("removes Win32 mode handlers on dispose()", () => {
    const addon = setupWin32InputMode();

    addon.dispose();

    expect(triggerCsi("?", "h", [9001])).toEqual([]);
    expect(triggerCsi("?", "l", [9001])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DragAndDropAddon
// ---------------------------------------------------------------------------

describe("DragAndDropAddon", () => {
  const VAULT = "/Users/me/My Vault",
    ESCAPED_VAULT = "/Users/me/My\\ Vault",
    DESKTOP = "/Users/me/Desktop",
    OVER_TYPES = ["dragenter", "dragover"] as const,
    DRAG_TYPES = [...OVER_TYPES, "dragleave", "drop"] as const,
    NOTICE_TIMEOUT = 7,
    // The bed's translator returns the key it is asked for.
    INSERT_PATH = "components.terminal.drag-insert-path",
    NO_PATHS = "notices.drop-no-paths",
    SKIPPED_PATHS = "notices.drop-skipped-paths",
    TEXT = "text/plain",
    URI_LIST = "text/uri-list",
    VSCODE_URI_LIST = "application/vnd.code.uri-list",
    // The class Obsidian 1.14.4 has on the body of its main window while it
    // drags a tab or something out of the vault, and never for a drag that
    // started in another application.
    GRABBING = "is-grabbing",
    // What real pointer drags onto the terminal carried in a Windows 11 guest
    // (VS Code 1.141.0, Edge 155), with the folder the dragged files were in
    // as a path and as VS Code writes it in a URI: lower-case drive letter,
    // encoded colon.
    WINDOWS_FOLDER = "C:\\Users\\janah\\Downloads\\tes-206-dnd",
    VSCODE_FOLDER = "file:///c%3A/Users/janah/Downloads/tes-206-dnd",
    EDGE_FOLDER = "file:///C:/Users/janah/Downloads/tes-206-dnd",
    // The types of a drag out of VS Code's file tree, in the order measured.
    VSCODE_TREE_TYPES = [
      TEXT,
      URI_LIST,
      "resourceurls",
      "codefiles",
      "chromium/x-drag-id",
      "codeeditors",
      VSCODE_URI_LIST,
    ],
    // Those of a link or an image dragged out of a page in Edge.
    EDGE_TYPES = [TEXT, URI_LIST, "text/html", "chromium/x-drag-id"],
    FILE_ON_DISK: DragAndDropStats = {
      isDirectory: () => false,
      isFile: () => true,
    };

  type DragType = (typeof DRAG_TYPES)[number];
  type DiskEntry = "directory" | "file" | "socket";
  type Bed = ReturnType<typeof createBed>;

  interface BedOptions {
    /** `app.dragManager.draggable`: what is dragged out of the vault, if anything. */
    readonly draggable?: unknown;
    /** Private properties of the app, replacing the drag manager made from `draggable`. */
    readonly app?: Readonly<Record<string, unknown>>;
    /** Executable of the profile's shell; zsh by default. */
    readonly executable?: string;
    /** Whether the vault is on the file system. */
    readonly fileSystem?: boolean;
    /** Absolute path of a vault path; under `VAULT` by default. */
    readonly fullPath?: (path: string) => string;
    /** Vault-relative paths the vault does not know. */
    readonly missing?: readonly string[];
    /** The addon of another copy of `emulator-addons.ts`; see `loadAddon`. */
    readonly Addon?: typeof DragAndDropAddon;
    /** The document of the terminal's window; that of the main window by default. */
    readonly document?: Document;
  }

  interface DragInit {
    readonly effectAllowed?: DataTransfer["effectAllowed"];
    readonly files?: readonly File[];
    readonly types?: readonly string[];
    /** The strings of the data transfer, by type. */
    readonly data?: Readonly<Record<string, string>>;
    /** What a `dragleave` enters; `null` outside the window. */
    readonly relatedTarget?: EventTarget | null;
    /** Whether a handler before the terminal's prevents the default. */
    readonly taken?: boolean;
  }

  /** A vault file or folder as the drag manager carries it. */
  function vaultFile(path: string): { readonly path: string } {
    return { path };
  }

  /** The draggable of one vault file. */
  function fileDraggable(path: string): unknown {
    return { file: vaultFile(path), type: "file" };
  }

  /** A file dragged in from the system; `path` is the legacy Electron property. */
  function nativeFile(name: string, path?: string): File {
    return { name, path } as unknown as File;
  }

  /** A drag out of the vault: Obsidian only puts a name or URL in `text/plain`. */
  function vaultDrag(init: DragInit = {}): DragInit {
    return { types: ["text/plain"], ...init };
  }

  /** A drag of files from the system. */
  function nativeDrag(
    files: readonly File[] = [nativeFile("b.png", `${DESKTOP}/b.png`)],
    init: DragInit = {},
  ): DragInit {
    return { files, types: ["Files"], ...init };
  }

  /**
   * A drag of links, which its source describes in `text/uri-list`; a browser
   * writes the link in `text/plain` as well.
   */
  function uriDrag(
    uriList = `file://${DESKTOP}/b.png`,
    init: DragInit = {},
  ): DragInit {
    return {
      data: { [TEXT]: uriList, [URI_LIST]: uriList },
      types: [URI_LIST, TEXT],
      ...init,
    };
  }

  /**
   * A drag out of VS Code, which allows a copy or a move. Its own list holds
   * every dragged item; `text/uri-list`, where it is present, only the first.
   */
  function vscodeDrag(
    types: readonly string[],
    data: Readonly<Record<string, string>>,
  ): DragInit {
    return { data, effectAllowed: "copyMove", types };
  }

  /** A file whose legacy Electron `path` cannot be read. */
  function unreadableFile(name: string): File {
    return Object.defineProperty({ name }, "path", {
      get(): never {
        throw new Error("File.path is gone");
      },
    }) as unknown as File;
  }

  /** A `stat` that is called but has not answered. */
  interface PendingStat {
    /** Answers it; with a file, unless told otherwise. */
    readonly answer: (stats?: DragAndDropStats) => void;
    readonly promise: Promise<DragAndDropStats>;
  }

  // Every `stat` a test left without an answer, for `afterEach` to answer:
  // until it has one, it holds one of the four lookups that all the addons of
  // a copy of `emulator-addons.ts` share, in the tests that follow as well.
  const pendingStats: PendingStat[] = [];

  /** A `stat` that has no answer until the test gives one. */
  function pendingStat(): PendingStat {
    let answer: (stats?: DragAndDropStats) => void = noop;
    const promise = new Promise<DragAndDropStats>((resolve) => {
        answer = (stats = FILE_ON_DISK): void => {
          resolve(stats);
        };
      }),
      pending = { answer, promise };
    pendingStats.push(pending);
    return pending;
  }

  /** Four of them, which is every lookup the addons may have outstanding. */
  function pendingStatsForEverySlot(): readonly PendingStat[] {
    return Array.from({ length: 4 }, pendingStat);
  }

  /** The file URIs of names on the desktop, as a URI list. */
  function desktopUriList(names: readonly string[]): string {
    return names.map((name) => `file://${DESKTOP}/${name}`).join("\r\n");
  }

  /**
   * Loads `emulator-addons.ts` anew: it requires Electron and the file system
   * once, when it loads, so a test that takes one of them away needs a copy
   * of its own. The copy shares the mocks above, but not `obsidian`.
   */
  async function loadAddon(): Promise<typeof DragAndDropAddon> {
    vi.resetModules();
    // Imported here, after the test has set what the module can require.
    const { DragAndDropAddon: Addon } =
      await import("../../../src/terminal/emulator-addons.js");
    return Addon;
  }

  /** Sets what is on the disk `stat` looks at; every other path is missing. */
  function onDisk(entries: Readonly<Record<string, DiskEntry>>): void {
    const disk = new Map(Object.entries(entries));
    dragAndDropEnvironment.stat.mockImplementation((path) => {
      const entry = disk.get(path);
      return entry === undefined
        ? Promise.reject(
            Object.assign(new Error(`ENOENT: stat '${path}'`), {
              code: "ENOENT",
            }),
          )
        : Promise.resolve({
            isDirectory: () => entry === "directory",
            isFile: () => entry === "file",
          });
    });
  }

  // Every `terminal.paste` of a test, to check that none pasted nothing.
  const pastes: Mock[] = [],
    // Every addon of a test, disposed after it: one that still waits for the
    // disk then looks nothing more up, and pastes nothing into a later test.
    addons: DragAndDropAddon[] = [],
    // Every element a test has put in the document to take the focus.
    focusables: HTMLElement[] = [];

  /**
   * The document of a pop-out window: another one than the global `document`,
   * which stays that of the main window. A document made this way has no
   * window, so it is given the main one for the console and the timers.
   */
  function popoutDocument(): Document {
    return Object.defineProperty(
      document.implementation.createHTMLDocument(),
      "defaultView",
      { value: window },
    );
  }

  /** An element of the window that takes the focus, as the editor of a note does. */
  function focusable(): HTMLElement {
    const input = document.body.appendChild(document.createElement("input"));
    focusables.push(input);
    return input;
  }

  /** Keys of the notices shown so far. */
  function notices(): readonly unknown[] {
    return vi.mocked(notice2).mock.calls.map(([message]) => message());
  }

  /**
   * Activates the addon on the element of a terminal inside a view.
   *
   * @param options - the vault, the profile and the vault drag in flight.
   */
  function createBed(options: BedOptions = {}) {
    const {
        Addon = DragAndDropAddon,
        draggable = null,
        executable = "/bin/zsh",
        fileSystem = true,
        fullPath = (path: string): string => `${VAULT}/${path}`,
        missing = [],
        document: ownerDocument = document,
      } = options,
      // The container of the view, where Obsidian has its own drag handlers.
      view = ownerDocument.createElement("div"),
      element = view.appendChild(ownerDocument.createElement("div")),
      reachedView = vi.fn<(event: Event) => void>(),
      addEventListener = vi.spyOn(element, "addEventListener"),
      removeEventListener = vi.spyOn(element, "removeEventListener"),
      focus = vi.fn(),
      paste = vi.fn(),
      terminal = { focus, paste } as unknown as Terminal,
      getFullPath = vi.fn(fullPath),
      getAbstractFileByPath = vi.fn((path: string) =>
        missing.includes(path) ? null : vaultFile(path),
      ),
      setAction = vi.fn(),
      dragManager = { draggable, setAction },
      app = {
        ...(options.app ?? { dragManager }),
        vault: {
          adapter: fileSystem
            ? Object.assign(new FileSystemAdapter(), { getFullPath })
            : { getFullPath },
          getAbstractFileByPath,
        },
      } as unknown as App,
      context = {
        app,
        language: { value: { t: vi.fn((key: string) => key) } },
        settings: { value: { noticeTimeout: NOTICE_TIMEOUT } },
      } as unknown as PluginContext,
      addon = new Addon(context, element, executable);

    for (const type of DRAG_TYPES) {
      view.addEventListener(type, reachedView);
    }
    pastes.push(paste);
    addons.push(addon);
    addon.activate(terminal);

    return {
      addEventListener,
      addon,
      context,
      dragManager,
      element,
      focus,
      paste,
      removeEventListener,
      setAction,
      terminal,
      view,
      /**
       * Dispatches a drag event on the terminal, as the browser does.
       *
       * @param type - type of the event.
       * @param init - its data transfer; `null` leaves it out.
       */
      fire(type: DragType, init: DragInit | null = {}) {
        const event = new Event(type, { bubbles: true, cancelable: true }),
          // A data transfer shows its types during the whole drag, but its
          // files and strings only while the drop is dispatched.
          readable = { now: false },
          getData = vi.fn((format: string) =>
            readable.now ? (init?.data?.[format] ?? "") : "",
          ),
          dataTransfer =
            init === null
              ? null
              : {
                  // A value the addon never sets, to tell when it set none.
                  dropEffect: "move",
                  effectAllowed: init.effectAllowed ?? "all",
                  get files(): readonly File[] {
                    return readable.now ? (init.files ?? []) : [];
                  },
                  getData,
                  types: init.types ?? [],
                };
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
        Object.defineProperty(event, "relatedTarget", {
          value: init?.relatedTarget ?? null,
        });
        if (init?.taken ?? false) {
          view.addEventListener(
            type,
            (taken) => {
              taken.preventDefault();
            },
            { capture: true, once: true },
          );
        }
        readable.now = type === "drop";
        element.dispatchEvent(event);
        readable.now = false;
        return {
          dataTransfer,
          event,
          getData,
          /** Whether the event went on to the view's own handlers. */
          reachedView: reachedView.mock.calls.some(([seen]) => seen === event),
        };
      },
    };
  }

  /** Drops on the terminal and waits until the paths are looked up and pasted. */
  async function drop(bed: Bed, init: DragInit | null = {}) {
    const dropped = bed.fire("drop", init);
    await tick();
    return dropped;
  }

  /** One drag of each kind the terminal takes: name, bed, data transfer. */
  const TAKEN_DRAGS: readonly (readonly [string, BedOptions, DragInit])[] = [
    [
      "a vault file",
      { draggable: fileDraggable("Assets/photo.png") },
      vaultDrag(),
    ],
    ["files from the system", {}, nativeDrag()],
    ["a URI list", {}, uriDrag()],
    [
      // All an editor tab of VS Code has.
      "a URI list of VS Code's kind",
      {},
      {
        data: { [VSCODE_URI_LIST]: `file://${DESKTOP}/b.png` },
        types: [VSCODE_URI_LIST],
      },
    ],
  ];

  beforeEach(() => {
    dragAndDropEnvironment.platform = "darwin";
    onDisk({});
    // Paths that are left out are reported at these levels.
    vi.spyOn(console, "debug").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
  });

  afterEach(async () => {
    for (const paste of pastes.splice(0)) {
      expect(paste).not.toHaveBeenCalledWith("");
    }
    // Nothing of this test may be left in the lookups the addons share: its
    // addons stop looking up, and each `stat` without an answer gets one.
    for (const addon of addons.splice(0)) {
      addon.dispose();
    }
    for (const pending of pendingStats.splice(0)) {
      pending.answer();
    }
    // `tick` needs the real `setImmediate`.
    vi.useRealTimers();
    await tick();
    document.body.classList.remove(GRABBING);
    for (const element of focusables.splice(0)) {
      element.blur();
      element.remove();
    }
    dragAndDropEnvironment.electron = true;
    dragAndDropEnvironment.fileSystem = true;
    dragAndDropEnvironment.platform = null;
    dragAndDropEnvironment.webUtils = void 0;
    dragAndDropEnvironment.stat.mockReset();
    vi.mocked(notice2).mockClear();
    vi.restoreAllMocks();
  });

  // === Listeners and disposal ===

  it("listens for every drag event as soon as it is activated", () => {
    const bed = createBed();

    expect(
      new Set(bed.addEventListener.mock.calls.map(([type]) => type)),
    ).toEqual(new Set(DRAG_TYPES));
  });

  it("takes a drop that comes right after it is activated", async () => {
    const bed = createBed();

    await drop(bed, nativeDrag());

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
  });

  it.each(DRAG_TYPES)("leaves %s untouched after dispose", async (type) => {
    const bed = createBed();

    bed.addon.dispose();
    const fired = bed.fire(type, nativeDrag());
    await tick();

    expect(fired.event.defaultPrevented).toBe(false);
    expect(fired.reachedView).toBe(true);
    expect(fired.dataTransfer?.dropEffect).toBe("move");
    expect(bed.paste).not.toHaveBeenCalled();
  });

  it("pastes nothing for a drop after dispose", async () => {
    const bed = createBed();

    await drop(bed, nativeDrag());
    bed.addon.dispose();
    await drop(bed, nativeDrag());

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
  });

  it("pastes nothing when disposed while dropped files are looked up", async () => {
    const getPathForFile = vi.fn(() => `${DESKTOP}/b.png`),
      bed = createBed();
    dragAndDropEnvironment.webUtils = { getPathForFile };

    bed.fire("drop", nativeDrag());
    bed.addon.dispose();
    await tick();

    expect(bed.paste).not.toHaveBeenCalled();
    expect(bed.focus).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    // The files of a drop whose terminal is gone are not even asked for a path.
    expect(getPathForFile).not.toHaveBeenCalled();
  });

  it("pastes nothing when disposed while a URI list is checked on disk", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed();

    await drop(bed, uriDrag());
    bed.addon.dispose();
    stat.answer();
    await tick();

    expect(dragAndDropEnvironment.stat).toHaveBeenCalledOnce();
    expect(bed.paste).not.toHaveBeenCalled();
    expect(bed.focus).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it("looks nothing up for a drop that waits behind another when disposed", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed();

    await drop(bed, uriDrag());
    await drop(bed, uriDrag(`file://${DESKTOP}/c.png`));
    bed.addon.dispose();
    stat.answer();
    await tick();

    expect(dragAndDropEnvironment.stat.mock.calls).toEqual([
      [`${DESKTOP}/b.png`],
    ]);
    expect(bed.paste).not.toHaveBeenCalled();
  });

  // A paste can set off a callback that closes the terminal.
  it.each<readonly [string, string, string, readonly string[], string]>([
    [
      // Each path is a paste of its own there, and the second is not pasted.
      "the first of two pastes on Windows",
      "win32",
      "cmd.exe",
      ["C:\\Users\\me\\a.png", "C:\\Users\\me\\b.png"],
      "C:\\Users\\me\\a.png ",
    ],
    [
      "the one paste of two paths",
      "darwin",
      "/bin/zsh",
      [`${DESKTOP}/a.png`, `${DESKTOP}/b.png`],
      `${DESKTOP}/a.png ${DESKTOP}/b.png `,
    ],
    [
      "the paste of the only path",
      "darwin",
      "/bin/zsh",
      [`${DESKTOP}/a.png`],
      `${DESKTOP}/a.png `,
    ],
  ])(
    "stops when %s disposes the addon, without focusing the terminal",
    async (_name, platform, executable, paths, pasted) => {
      dragAndDropEnvironment.platform = platform;
      const bed = createBed({ executable });
      bed.paste.mockImplementationOnce(() => {
        bed.addon.dispose();
      });

      await drop(
        bed,
        nativeDrag(paths.map((path) => nativeFile("dropped.png", path))),
      );

      expect(bed.paste.mock.calls).toEqual([[pasted]]);
      expect(bed.focus).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    },
  );

  it("removes every listener it added on dispose", () => {
    const bed = createBed();

    bed.addon.dispose();

    expect(
      bed.removeEventListener.mock.calls.map(([type, listener]) => [
        type,
        listener,
      ]),
    ).toEqual(
      expect.arrayContaining(
        bed.addEventListener.mock.calls.map(([type, listener]) => [
          type,
          listener,
        ]),
      ),
    );
    expect(bed.removeEventListener).toHaveBeenCalledTimes(DRAG_TYPES.length);
  });

  it("pastes into the terminal of its last activation only", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed(),
      focus = vi.fn(),
      paste = vi.fn();
    pastes.push(paste);

    // A drop that is still looked up on disk when the terminal is replaced
    // belongs to neither terminal by the time it has its answer.
    await drop(bed, uriDrag());
    bed.addon.activate({ focus, paste } as unknown as Terminal);
    stat.answer();
    await tick();

    expect(bed.paste).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);

    bed.dragManager.draggable = fileDraggable("a.png");
    bed.fire("dragover", vaultDrag());
    await drop(bed, vaultDrag());

    expect(bed.paste).not.toHaveBeenCalled();
    expect(bed.focus).not.toHaveBeenCalled();
    expect(paste.mock.calls).toEqual([[`${ESCAPED_VAULT}/a.png `]]);
    expect(focus).toHaveBeenCalledOnce();
    // One `dragover` listener is left, not two.
    expect(bed.setAction).toHaveBeenCalledOnce();
    expect(bed.removeEventListener).toHaveBeenCalledTimes(DRAG_TYPES.length);
  });

  it("shows no notice for a drop without a path that is looked up when the terminal is replaced", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed();

    await drop(bed, uriDrag());
    bed.addon.activate(bed.terminal);
    stat.answer({ isDirectory: () => false, isFile: () => false });
    await tick();

    expect(bed.paste).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it("looks nothing up for a drop that waits behind another when the terminal is replaced", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed();

    await drop(bed, uriDrag());
    await drop(bed, uriDrag(`file://${DESKTOP}/c.png`));
    bed.addon.activate(bed.terminal);
    stat.answer();
    await tick();

    expect(dragAndDropEnvironment.stat.mock.calls).toEqual([
      [`${DESKTOP}/b.png`],
    ]);
    expect(bed.paste).not.toHaveBeenCalled();
    expect(bed.focus).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it.each(DRAG_TYPES)(
    "leaves %s untouched when activated after dispose",
    async (type) => {
      const bed = createBed();

      bed.addon.dispose();
      bed.addEventListener.mockClear();
      bed.addon.activate(bed.terminal);
      const fired = bed.fire(type, nativeDrag());
      await tick();

      expect(bed.addEventListener).not.toHaveBeenCalled();
      expect(fired.event.defaultPrevented).toBe(false);
      expect(fired.reachedView).toBe(true);
      expect(bed.paste).not.toHaveBeenCalled();
    },
  );

  it("logs a failed drop instead of leaving a rejection unhandled", async () => {
    const failure = new Error("terminal is gone"),
      error = vi.spyOn(console, "error").mockImplementation(noop),
      bed = createBed();
    bed.paste.mockImplementation(() => {
      throw failure;
    });

    await drop(bed, nativeDrag());

    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
  });

  // === Drags that are not for the terminal ===

  describe.each<readonly [string, DragInit | null]>([
    ["a text selection", { types: ["text/plain", "text/html"] }],
    // Obsidian drags a tab with an empty `text/plain` and no draggable.
    ["a tab header", { types: ["text/plain"] }],
    ["an empty data transfer", {}],
    ["no data transfer", null],
  ])("with %s dragged", (_name, init) => {
    it.each(DRAG_TYPES)("leaves %s untouched", async (type) => {
      const bed = createBed(),
        fired = bed.fire(type, init);
      await tick();

      expect(fired.event.defaultPrevented).toBe(false);
      expect(fired.reachedView).toBe(true);
      expect(fired.dataTransfer?.dropEffect ?? "move").toBe("move");
      expect(fired.getData).not.toHaveBeenCalled();
      expect(bed.paste).not.toHaveBeenCalled();
      expect(bed.focus).not.toHaveBeenCalled();
      expect(bed.setAction).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    });
  });

  // While Obsidian drags a tab, the body of its main window has the class
  // `is-grabbing`. A tab grabbed by an image in its header (the icon of a web
  // page) carries what Chromium adds for the image as well, so nothing but
  // that class tells it from a drag out of another application.
  describe.each<readonly [string, DragInit, readonly string[]]>([
    [
      "the image as a file and a URI",
      {
        data: { [TEXT]: "", [URI_LIST]: "https://example.com/favicon.ico" },
        files: [nativeFile("favicon.ico", "")],
        types: [TEXT, URI_LIST, "text/html", "Files"],
      },
      [],
    ],
    [
      "the image as a URI",
      {
        data: { [TEXT]: "", [URI_LIST]: `file://${DESKTOP}/b.png` },
        types: [TEXT, URI_LIST],
      },
      [`${DESKTOP}/b.png `],
    ],
    [
      "a list of VS Code's kind",
      {
        data: { [TEXT]: "", [VSCODE_URI_LIST]: `file://${DESKTOP}/b.png` },
        types: [TEXT, VSCODE_URI_LIST],
      },
      [`${DESKTOP}/b.png `],
    ],
  ])("with a drag that carries %s", (_name, init, pasted) => {
    it.each(DRAG_TYPES)(
      "leaves %s untouched while Obsidian drags a tab",
      async (type) => {
        document.body.classList.add(GRABBING);
        onDisk({ [`${DESKTOP}/b.png`]: "file" });
        const bed = createBed(),
          fired = bed.fire(type, init);
        await tick();

        expect(fired.event.defaultPrevented).toBe(false);
        expect(fired.reachedView).toBe(true);
        expect(fired.dataTransfer?.dropEffect).toBe("move");
        expect(fired.getData).not.toHaveBeenCalled();
        expect(dragAndDropEnvironment.stat).not.toHaveBeenCalled();
        expect(bed.paste).not.toHaveBeenCalled();
        expect(bed.focus).not.toHaveBeenCalled();
        expect(bed.setAction).not.toHaveBeenCalled();
        expect(notices()).toEqual([]);
      },
    );

    it.each(OVER_TYPES)(
      "accepts %s of the same drag out of another application",
      (type) => {
        const bed = createBed(),
          over = bed.fire(type, init);

        expect(over.event.defaultPrevented).toBe(true);
        expect(over.dataTransfer?.dropEffect).toBe("copy");
      },
    );

    it("takes the drop of the same drag out of another application", async () => {
      onDisk({ [`${DESKTOP}/b.png`]: "file" });
      const bed = createBed(),
        dropped = await drop(bed, init);

      expect(dropped.event.defaultPrevented).toBe(true);
      expect(dropped.reachedView).toBe(false);
      expect(bed.paste.mock.calls).toEqual(pasted.map((text) => [text]));
      expect(notices()).toEqual(pasted.length > 0 ? [] : [NO_PATHS]);
    });
  });

  it("pastes files from another application that come with an empty text/plain", async () => {
    const bed = createBed(),
      dropped = await drop(
        bed,
        nativeDrag([nativeFile("b.png", `${DESKTOP}/b.png`)], {
          data: { [TEXT]: "" },
          types: [TEXT, "Files"],
        }),
      );

    expect(dropped.event.defaultPrevented).toBe(true);
    expect(dropped.getData).not.toHaveBeenCalled();
    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([]);
  });

  // Obsidian's drag manager sets the class for its own drags as well.
  it("still takes a vault drag, which Obsidian marks as it marks a tab", async () => {
    document.body.classList.add(GRABBING);
    const bed = createBed({ draggable: fileDraggable("Assets/photo.png") }),
      over = bed.fire("dragover", vaultDrag()),
      dropped = await drop(bed, vaultDrag());

    expect(over.event.defaultPrevented).toBe(true);
    expect(over.dataTransfer?.dropEffect).toBe("copy");
    expect(bed.setAction).toHaveBeenCalledExactlyOnceWith(INSERT_PATH);
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(bed.paste.mock.calls).toEqual([
      [`${ESCAPED_VAULT}/Assets/photo.png `],
    ]);
  });

  describe("in a pop-out window", () => {
    // Obsidian marks a drag on the body of its main window only.
    it.each(DRAG_TYPES)(
      "leaves %s untouched while Obsidian drags a tab",
      async (type) => {
        document.body.classList.add(GRABBING);
        const bed = createBed({ document: popoutDocument() }),
          fired = bed.fire(type, nativeDrag());
        await tick();

        expect(fired.event.defaultPrevented).toBe(false);
        expect(fired.reachedView).toBe(true);
        expect(bed.paste).not.toHaveBeenCalled();
        expect(notices()).toEqual([]);
      },
    );

    it("takes a drop out of another application", async () => {
      const popout = popoutDocument(),
        bed = createBed({ document: popout });
      // Not where Obsidian marks a drag, so not read.
      popout.body.classList.add(GRABBING);

      await drop(bed, nativeDrag());

      expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    });
  });

  // === Accepting and refusing a drag ===

  describe.each(TAKEN_DRAGS)("with %s dragged", (_name, options, init) => {
    it.each(OVER_TYPES)("accepts the drag as a copy on %s", (type) => {
      const bed = createBed(options),
        over = bed.fire(type, init);

      expect(over.event.defaultPrevented).toBe(true);
      expect(over.dataTransfer?.dropEffect).toBe("copy");
      expect(bed.paste).not.toHaveBeenCalled();
    });

    // Obsidian moves its drag ghost from window-level `dragover` listeners.
    it.each(OVER_TYPES)("lets %s go on to the view and the window", (type) => {
      const bed = createBed(options),
        over = bed.fire(type, init);

      expect(over.reachedView).toBe(true);
    });

    it.each(OVER_TYPES)(
      "leaves %s alone when another handler has answered it",
      (type) => {
        const bed = createBed(options),
          over = bed.fire(type, { ...init, taken: true });

        expect(over.dataTransfer?.dropEffect).toBe("move");
        expect(over.reachedView).toBe(true);
        expect(bed.setAction).not.toHaveBeenCalled();
      },
    );

    it.each<readonly [DataTransfer["effectAllowed"], string]>([
      ["all", "copy"],
      ["copy", "copy"],
      ["copyLink", "copy"],
      ["copyMove", "copy"],
      ["uninitialized", "copy"],
      ["link", "link"],
      ["linkMove", "link"],
      // Never a move: a file manager may delete the source after one.
      ["move", "none"],
      ["none", "none"],
    ])(
      "answers a source allowing %s with the drop effect %s",
      (effectAllowed, dropEffect) => {
        const bed = createBed(options),
          over = bed.fire("dragover", { ...init, effectAllowed });

        expect(over.event.defaultPrevented).toBe(true);
        expect(over.dataTransfer?.dropEffect).toBe(dropEffect);
        expect(over.reachedView).toBe(true);
      },
    );

    it("leaves a drop alone when another handler took it", async () => {
      onDisk({ [`${DESKTOP}/b.png`]: "file" });
      const bed = createBed(options),
        dropped = await drop(bed, { ...init, taken: true });

      expect(dropped.reachedView).toBe(true);
      expect(dropped.getData).not.toHaveBeenCalled();
      expect(bed.paste).not.toHaveBeenCalled();
      expect(bed.focus).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    });

    it("pastes on drop and keeps the drop from the view", async () => {
      onDisk({ [`${DESKTOP}/b.png`]: "file" });
      const bed = createBed(options),
        dropped = await drop(bed, init);

      expect(bed.paste).toHaveBeenCalledOnce();
      expect(dropped.event.defaultPrevented).toBe(true);
      expect(dropped.reachedView).toBe(false);
    });

    it("focuses the terminal once after a drop", async () => {
      onDisk({ [`${DESKTOP}/b.png`]: "file" });
      const bed = createBed(options);

      await drop(bed, init);

      expect(bed.focus).toHaveBeenCalledOnce();
    });

    it("shows no notice when everything dropped is inserted", async () => {
      onDisk({ [`${DESKTOP}/b.png`]: "file" });
      const bed = createBed(options);

      await drop(bed, init);

      expect(notices()).toEqual([]);
    });
  });

  // === Label on Obsidian's drag ghost ===

  it.each(OVER_TYPES)(
    "labels Obsidian's drag ghost on %s of a vault file",
    (type) => {
      const bed = createBed({ draggable: fileDraggable("Assets/photo.png") });

      bed.fire(type, vaultDrag());

      expect(bed.setAction).toHaveBeenCalledExactlyOnceWith(INSERT_PATH);
      expect(bed.setAction.mock.contexts).toEqual([bed.dragManager]);
    },
  );

  // In a pop-out window Obsidian does not clear the label itself.
  describe.each<readonly [string, BedOptions, DragInit]>([
    [
      "a vault drag without a path",
      { draggable: { file: null, linktext: "Missing", type: "link" } },
      vaultDrag(),
    ],
    [
      "a vault file from a source that only allows a move",
      { draggable: fileDraggable("Assets/photo.png") },
      vaultDrag({ effectAllowed: "move" }),
    ],
  ])("with %s dragged", (_name, options, init) => {
    it.each(OVER_TYPES)("takes the label off the drag ghost on %s", (type) => {
      const bed = createBed(options);

      bed.fire(type, init);

      expect(bed.setAction).toHaveBeenCalledExactlyOnceWith(null);
      expect(bed.setAction.mock.contexts).toEqual([bed.dragManager]);
    });
  });

  it.each<readonly [string, DragInit]>([
    ["files from the system", nativeDrag()],
    ["a URI list", uriDrag()],
  ])("leaves the drag ghost alone for %s", (_name, init) => {
    const bed = createBed();

    for (const type of [...OVER_TYPES, "dragleave"] as const) {
      bed.fire(type, init);
    }

    expect(bed.setAction).not.toHaveBeenCalled();
  });

  it.each<readonly [string, (bed: Bed) => EventTarget | null]>([
    ["the window", (): null => null],
    ["the view around the terminal", (bed): EventTarget => bed.view],
  ])(
    "takes the label off the drag ghost when a vault drag leaves for %s",
    (_name, entered) => {
      const bed = createBed({ draggable: fileDraggable("Assets/photo.png") });

      bed.fire("dragover", vaultDrag());
      bed.setAction.mockClear();
      const left = bed.fire(
        "dragleave",
        vaultDrag({ relatedTarget: entered(bed) }),
      );

      expect(bed.setAction).toHaveBeenCalledExactlyOnceWith(null);
      expect(bed.setAction.mock.contexts).toEqual([bed.dragManager]);
      expect(left.event.defaultPrevented).toBe(false);
      expect(left.reachedView).toBe(true);
    },
  );

  it.each<readonly [string, (bed: Bed) => EventTarget]>([
    ["the terminal itself", (bed): EventTarget => bed.element],
    [
      "an element inside it",
      (bed): EventTarget =>
        bed.element
          .appendChild(document.createElement("div"))
          .appendChild(document.createElement("canvas")),
    ],
  ])("keeps the label while a vault drag moves on to %s", (_name, entered) => {
    const bed = createBed({ draggable: fileDraggable("Assets/photo.png") });

    bed.fire("dragover", vaultDrag());
    bed.fire("dragleave", vaultDrag({ relatedTarget: entered(bed) }));

    expect(bed.setAction.mock.calls).toEqual([[INSERT_PATH]]);
  });

  it("leaves the drag ghost alone when a vault drag leaves after dispose", () => {
    const bed = createBed({ draggable: fileDraggable("Assets/photo.png") });

    bed.addon.dispose();
    bed.fire("dragleave", vaultDrag());

    expect(bed.setAction).not.toHaveBeenCalled();
  });

  describe.each<readonly [string, Readonly<Record<string, unknown>>]>([
    ["no setAction", {}],
    ["a setAction that is not a function", { setAction: "Insert path" }],
    [
      "a setAction that throws",
      {
        setAction: (): never => {
          throw new Error("no drag ghost");
        },
      },
    ],
  ])("with a drag manager with %s", (_name, labelling) => {
    const app = {
      dragManager: {
        draggable: fileDraggable("Assets/photo.png"),
        ...labelling,
      },
    };

    it("still accepts a vault file", () => {
      const bed = createBed({ app }),
        over = bed.fire("dragover", vaultDrag());

      expect(over.event.defaultPrevented).toBe(true);
      expect(over.dataTransfer?.dropEffect).toBe("copy");
      expect(over.reachedView).toBe(true);
    });

    it("still pastes a dropped vault file", async () => {
      const bed = createBed({ app });

      bed.fire("dragover", vaultDrag());
      bed.fire("dragleave", vaultDrag());
      await drop(bed, vaultDrag());

      expect(bed.paste.mock.calls).toEqual([
        [`${ESCAPED_VAULT}/Assets/photo.png `],
      ]);
    });

    it("still refuses a vault file from a source that only allows a move", () => {
      const bed = createBed({ app }),
        over = bed.fire("dragover", vaultDrag({ effectAllowed: "move" }));

      expect(over.event.defaultPrevented).toBe(true);
      expect(over.dataTransfer?.dropEffect).toBe("none");
    });
  });

  // === Vault drags ===

  it.each<readonly [string, unknown, readonly string[]]>([
    [
      "a file",
      { file: vaultFile("Assets/photo 1.png"), type: "file" },
      ["Assets/photo\\ 1.png"],
    ],
    ["a folder", { file: vaultFile("Assets"), type: "folder" }, ["Assets"]],
    [
      "a multi-selection in drag order, without duplicates",
      {
        files: [
          vaultFile("b.png"),
          vaultFile("Notes/a.md"),
          vaultFile("b.png"),
          vaultFile("Assets"),
        ],
        type: "files",
      },
      ["b.png", "Notes/a.md", "Assets"],
    ],
    [
      "the target of a resolved link",
      {
        file: vaultFile("Assets/photo.png"),
        linktext: "photo.png",
        sourcePath: "Notes/a.md",
        type: "link",
      },
      ["Assets/photo.png"],
    ],
    [
      "the files and folders among bookmarks",
      {
        items: [
          { item: { path: "Notes/a.md", type: "file" } },
          { item: { items: [], title: "Group", type: "group" } },
          { item: { path: "Assets", type: "folder" } },
          { item: { query: "tag:#todo", type: "search" } },
        ],
        type: "bookmarks",
      },
      ["Notes/a.md", "Assets"],
    ],
    [
      "the note of a Bases card",
      { entry: { file: vaultFile("Notes/card.md") }, type: "kanban-card" },
      ["Notes/card.md"],
    ],
  ])(
    "pastes %s dropped out of the vault, in one paste",
    async (_name, draggable, expected) => {
      const bed = createBed({ draggable });

      await drop(bed, vaultDrag());

      expect(bed.paste.mock.calls).toEqual([
        [expected.map((path) => `${ESCAPED_VAULT}/${path} `).join("")],
      ]);
    },
  );

  it("keeps the extension of a note, which the dragged URL lacks", async () => {
    const bed = createBed({ draggable: fileDraggable("Notes/My note.md") }),
      dropped = await drop(
        bed,
        vaultDrag({
          data: {
            [URI_LIST]:
              "obsidian://open?vault=My%20Vault&file=Notes%2FMy%20note",
          },
          types: [TEXT, URI_LIST],
        }),
      );

    expect(bed.paste.mock.calls).toEqual([
      [`${ESCAPED_VAULT}/Notes/My\\ note.md `],
    ]);
    expect(dropped.getData).not.toHaveBeenCalled();
  });

  it("reads the vault drag while the drop is dispatched", async () => {
    const bed = createBed({ draggable: fileDraggable("a.png") });

    bed.fire("drop", vaultDrag());
    // Obsidian clears the draggable in a timer right after the drop.
    bed.dragManager.draggable = null;
    await tick();

    expect(bed.paste.mock.calls).toEqual([[`${ESCAPED_VAULT}/a.png `]]);
  });

  it("reads the drag in flight at each event", async () => {
    const bed = createBed();

    bed.dragManager.draggable = fileDraggable("a.png");
    await drop(bed, vaultDrag());
    bed.dragManager.draggable = null;
    await drop(bed, vaultDrag());

    expect(bed.paste.mock.calls).toEqual([[`${ESCAPED_VAULT}/a.png `]]);
  });

  it("pastes only the vault paths of a vault drag that also carries files", async () => {
    const getPathForFile = vi.fn(() => `${DESKTOP}/b.png`),
      bed = createBed({ draggable: fileDraggable("Assets/photo.png") });
    dragAndDropEnvironment.webUtils = { getPathForFile };

    await drop(bed, nativeDrag());

    expect(bed.paste.mock.calls).toEqual([
      [`${ESCAPED_VAULT}/Assets/photo.png `],
    ]);
    expect(getPathForFile).not.toHaveBeenCalled();
  });

  it("pastes only the vault path of an embedded image", async () => {
    // Chromium adds the dragged image itself as a file without a path.
    dragAndDropEnvironment.webUtils = { getPathForFile: () => "" };
    const bed = createBed({
      draggable: {
        file: vaultFile("Assets/photo.png"),
        linktext: "photo.png",
        sourcePath: "Notes/a.md",
        type: "link",
      },
    });

    await drop(bed, nativeDrag([nativeFile("photo.png")]));

    expect(bed.paste.mock.calls).toEqual([
      [`${ESCAPED_VAULT}/Assets/photo.png `],
    ]);
    expect(notices()).toEqual([]);
  });

  it("leaves out a vault path the vault no longer knows and says so", async () => {
    const bed = createBed({
        draggable: {
          files: [vaultFile("gone.md"), vaultFile("here.md")],
          type: "files",
        },
        // Deleted while it was dragged.
        missing: ["gone.md"],
      }),
      dropped = await drop(bed, vaultDrag());

    expect(bed.paste.mock.calls).toEqual([[`${ESCAPED_VAULT}/here.md `]]);
    expect(dropped.reachedView).toBe(false);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("leaves out a vault file name with a newline and says so", async () => {
    const bed = createBed({
      draggable: {
        files: [vaultFile("Notes/a\nrm -rf ~.md"), vaultFile("Notes/b.md")],
        type: "files",
      },
    });

    await drop(bed, vaultDrag());

    expect(bed.paste.mock.calls).toEqual([[`${ESCAPED_VAULT}/Notes/b.md `]]);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("never pastes a vault file name with a newline", async () => {
    const bed = createBed({
        draggable: fileDraggable("Notes/a\nrm -rf ~.md"),
      }),
      dropped = await drop(bed, vaultDrag());

    expect(bed.paste).not.toHaveBeenCalled();
    expect(bed.focus).not.toHaveBeenCalled();
    expect(dropped.event.defaultPrevented).toBe(true);
    // The file is one of this computer: only its path cannot be written.
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  // === Vault drags without a path that can be written for the shell ===

  // The cursor must not promise an insertion that the drop then declines.
  describe.each<readonly [string, string]>([
    ["a newline", "Notes/a\nrm -rf ~.md"],
    ["a tab", "Notes/a\tb.md"],
  ])("with a vault file whose name has %s dragged", (_name, path) => {
    it.each(OVER_TYPES)(
      "refuses the drag on %s and takes the label off the drag ghost",
      (type) => {
        const bed = createBed({ draggable: fileDraggable(path) }),
          over = bed.fire(type, vaultDrag());

        // Prevented, so that Obsidian does not open the file in this tab.
        expect(over.event.defaultPrevented).toBe(true);
        expect(over.dataTransfer?.dropEffect).toBe("none");
        expect(over.reachedView).toBe(true);
        expect(bed.setAction).toHaveBeenCalledExactlyOnceWith(null);
        expect(bed.paste).not.toHaveBeenCalled();
      },
    );
  });

  it("accepts a multi-selection of which one path can be written, pastes that one and says so", async () => {
    const bed = createBed({
        draggable: {
          // The one that cannot be written comes first.
          files: [vaultFile("Notes/a\nrm -rf ~.md"), vaultFile("Notes/b.md")],
          type: "files",
        },
      }),
      accepted = OVER_TYPES.map((type) => bed.fire(type, vaultDrag()));

    for (const over of accepted) {
      expect(over.event.defaultPrevented).toBe(true);
      expect(over.dataTransfer?.dropEffect).toBe("copy");
    }
    expect(bed.setAction.mock.calls).toEqual([[INSERT_PATH], [INSERT_PATH]]);

    await drop(bed, vaultDrag());

    expect(bed.paste.mock.calls).toEqual([[`${ESCAPED_VAULT}/Notes/b.md `]]);
    expect(bed.focus).toHaveBeenCalledOnce();
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("asks the shell of the terminal whether a vault path can be written", () => {
    dragAndDropEnvironment.platform = "win32";
    // `cmd.exe` has no way to write a double quote; PowerShell has one.
    const options: BedOptions = {
        draggable: fileDraggable('say "hi".png'),
        fullPath: (path) => `C:\\Vault\\${path}`,
      },
      cmd = createBed({ ...options, executable: "cmd.exe" }),
      powershell = createBed({ ...options, executable: "powershell.exe" });

    expect(cmd.fire("dragover", vaultDrag()).dataTransfer?.dropEffect).toBe(
      "none",
    );
    expect(cmd.setAction).toHaveBeenCalledExactlyOnceWith(null);
    expect(
      powershell.fire("dragover", vaultDrag()).dataTransfer?.dropEffect,
    ).toBe("copy");
    expect(powershell.setAction).toHaveBeenCalledExactlyOnceWith(INSERT_PATH);
  });

  // === Vault drags without a path to insert ===

  describe.each<readonly [string, BedOptions]>([
    [
      "an unresolved link",
      {
        draggable: {
          file: null,
          linktext: "Missing",
          sourcePath: "a.md",
          type: "link",
        },
      },
    ],
    [
      "a heading",
      {
        draggable: {
          file: vaultFile("Notes/a.md"),
          heading: { heading: "Title" },
          type: "heading",
        },
      },
    ],
    [
      "a bookmark group and a bookmarked search",
      {
        draggable: {
          items: [
            { item: { items: [], title: "Group", type: "group" } },
            { item: { query: "tag:#todo", type: "search" } },
          ],
          type: "bookmarks",
        },
      },
    ],
    [
      "a file the vault does not know",
      { draggable: fileDraggable("gone.md"), missing: ["gone.md"] },
    ],
    [
      "a file of a vault that is not on the file system",
      { draggable: fileDraggable("Assets/photo.png"), fileSystem: false },
    ],
  ])("with %s dragged out of the vault", (_name, options) => {
    it.each(OVER_TYPES)(
      "refuses the drag on %s without stopping it",
      (type) => {
        const bed = createBed(options),
          over = bed.fire(type, vaultDrag());

        // Prevented, so that Obsidian does not open the file in this tab.
        expect(over.event.defaultPrevented).toBe(true);
        expect(over.dataTransfer?.dropEffect).toBe("none");
        expect(over.reachedView).toBe(true);
        expect(bed.setAction).not.toHaveBeenCalledWith(INSERT_PATH);
      },
    );

    it.each(OVER_TYPES)(
      "leaves %s alone when another handler has answered it",
      (type) => {
        const bed = createBed(options),
          over = bed.fire(type, vaultDrag({ taken: true }));

        expect(over.dataTransfer?.dropEffect).toBe("move");
        expect(over.reachedView).toBe(true);
        expect(bed.setAction).not.toHaveBeenCalled();
      },
    );

    it("pastes nothing on drop and says so, without letting the drop through", async () => {
      const bed = createBed(options),
        dropped = await drop(bed, vaultDrag());

      expect(bed.paste).not.toHaveBeenCalled();
      expect(bed.focus).not.toHaveBeenCalled();
      expect(dropped.event.defaultPrevented).toBe(true);
      // The drag was the terminal's, with or without a path to insert.
      expect(dropped.reachedView).toBe(false);
      expect(notices()).toEqual([NO_PATHS]);
    });
  });

  // === Files from the system ===

  it("pastes files from the system through webUtils.getPathForFile, in one paste", async () => {
    const files = [nativeFile("shot 1.png"), nativeFile("b.png")],
      getPathForFile = vi.fn((file: File) => `${DESKTOP}/${file.name}`),
      bed = createBed();
    dragAndDropEnvironment.webUtils = { getPathForFile };

    await drop(bed, nativeDrag(files));

    expect(getPathForFile.mock.calls).toEqual([[files[0]], [files[1]]]);
    expect(bed.paste.mock.calls).toEqual([
      [`${DESKTOP}/shot\\ 1.png ${DESKTOP}/b.png `],
    ]);
  });

  it("does not check files from the system on disk", async () => {
    const bed = createBed();

    await drop(bed, nativeDrag());

    expect(bed.paste).toHaveBeenCalledOnce();
    expect(dragAndDropEnvironment.stat).not.toHaveBeenCalled();
  });

  it("does not read a URI list the drag does not have", async () => {
    const bed = createBed(),
      dropped = await drop(bed, nativeDrag());

    expect(dropped.getData).not.toHaveBeenCalled();
  });

  it("falls back to the legacy File.path without webUtils", async () => {
    const bed = createBed();

    await drop(bed, nativeDrag([nativeFile("a b.png", `${DESKTOP}/a b.png`)]));

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/a\\ b.png `]]);
  });

  it("falls back to the legacy File.path when webUtils.getPathForFile throws", async () => {
    dragAndDropEnvironment.webUtils = {
      getPathForFile: (): never => {
        throw new Error("not a file");
      },
    };
    const bed = createBed();

    await drop(bed, nativeDrag([nativeFile("b.png", `${DESKTOP}/b.png`)]));

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([]);
  });

  it("leaves out a file webUtils.getPathForFile throws for and says so", async () => {
    dragAndDropEnvironment.webUtils = {
      getPathForFile: (file: File): string => {
        if (file.name === "blob.png") {
          throw new Error("not a file");
        }
        return `${DESKTOP}/${file.name}`;
      },
    };
    const bed = createBed();

    await drop(bed, nativeDrag([nativeFile("blob.png"), nativeFile("b.png")]));

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("takes the legacy File.path of a file webUtils has no path for", async () => {
    dragAndDropEnvironment.webUtils = { getPathForFile: () => "" };
    const bed = createBed();

    await drop(bed, nativeDrag([nativeFile("b.png", `${DESKTOP}/b.png`)]));

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([]);
  });

  it("prefers the path webUtils gives to the legacy File.path", async () => {
    dragAndDropEnvironment.webUtils = {
      getPathForFile: () => `${DESKTOP}/real.png`,
    };
    const bed = createBed();

    await drop(bed, nativeDrag([nativeFile("b.png", `${DESKTOP}/b.png`)]));

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/real.png `]]);
  });

  it.each<readonly [string, DragAndDropEnvironment["webUtils"]]>([
    ["without webUtils", void 0],
    ["with a webUtils that has no path for it", { getPathForFile: () => "" }],
    [
      "with a webUtils that throws for it",
      {
        getPathForFile: (): never => {
          throw new Error("not a file");
        },
      },
    ],
  ])(
    "leaves out a file whose legacy File.path throws, %s, and pastes the others",
    async (_name, webUtils) => {
      dragAndDropEnvironment.webUtils = webUtils;
      const bed = createBed();

      await drop(
        bed,
        nativeDrag([
          nativeFile("a.png", `${DESKTOP}/a.png`),
          unreadableFile("bad.png"),
          nativeFile("b.png", `${DESKTOP}/b.png`),
        ]),
      );

      expect(bed.paste.mock.calls).toEqual([
        [`${DESKTOP}/a.png ${DESKTOP}/b.png `],
      ]);
      expect(notices()).toEqual([SKIPPED_PATHS]);
    },
  );

  it.each<readonly [string, () => void, File]>([
    [
      "an empty path from webUtils",
      (): void => {
        dragAndDropEnvironment.webUtils = { getPathForFile: () => "" };
      },
      nativeFile("image.png"),
    ],
    ["an empty legacy path", noop, nativeFile("image.png", "")],
    ["no path at all", noop, nativeFile("image.png")],
    ["a legacy path that throws", noop, unreadableFile("image.png")],
  ])(
    "pastes nothing for a file with %s, without letting the drop through",
    async (_name, arrange, file) => {
      arrange();
      const bed = createBed(),
        dropped = await drop(bed, nativeDrag([file]));

      expect(bed.paste).not.toHaveBeenCalled();
      expect(bed.focus).not.toHaveBeenCalled();
      // The browser would open the file, and so might a handler further up.
      expect(dropped.event.defaultPrevented).toBe(true);
      expect(dropped.reachedView).toBe(false);
      expect(notices()).toEqual([NO_PATHS]);
    },
  );

  it("leaves out a file without a path among others and says so", async () => {
    const bed = createBed();

    await drop(
      bed,
      nativeDrag([
        nativeFile("image.png"),
        nativeFile("b.png", `${DESKTOP}/b.png`),
      ]),
    );

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("never pastes the name of a file from the system with a newline", async () => {
    const bed = createBed();

    await drop(
      bed,
      nativeDrag([
        nativeFile("evil", `${DESKTOP}/a\nrm -rf ~`),
        nativeFile("b.png", `${DESKTOP}/b.png`),
      ]),
    );

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("says that a file was left out, not that there was none, when no path can be written", async () => {
    const bed = createBed(),
      dropped = await drop(
        bed,
        nativeDrag([nativeFile("evil", `${DESKTOP}/a\nrm -rf ~`)]),
      );

    expect(bed.paste).not.toHaveBeenCalled();
    expect(bed.focus).not.toHaveBeenCalled();
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("pastes a file dropped twice once, without a notice", async () => {
    const bed = createBed();

    await drop(
      bed,
      nativeDrag([
        nativeFile("b.png", `${DESKTOP}/b.png`),
        nativeFile("b.png", `${DESKTOP}/b.png`),
      ]),
    );

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([]);
  });

  it("still pastes files from the system when the vault is not on the file system", async () => {
    const bed = createBed({ fileSystem: false });

    await drop(bed, nativeDrag());

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
  });

  // === URI lists ===

  it("pastes the files and directories of a URI list, in one paste", async () => {
    onDisk({
      [`${DESKTOP}/a b.png`]: "file",
      [`${DESKTOP}/Shots`]: "directory",
    });
    const bed = createBed();

    await drop(
      bed,
      uriDrag(`file://${DESKTOP}/a%20b.png\r\nfile://${DESKTOP}/Shots\r\n`),
    );

    expect(bed.paste.mock.calls).toEqual([
      [`${DESKTOP}/a\\ b.png ${DESKTOP}/Shots `],
    ]);
    expect(notices()).toEqual([]);
  });

  it("reads the URI list while the drop is dispatched", async () => {
    onDisk({ [`${DESKTOP}/b.png`]: "file" });
    const bed = createBed(),
      // The data transfer answers with an empty string after the dispatch.
      dropped = await drop(bed, uriDrag());

    // The list the drag has, once; `text/plain` is not read.
    expect(dropped.getData.mock.calls).toEqual([[URI_LIST]]);
    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
  });

  it("reads both URI lists of a drag that has two, while the drop is dispatched", async () => {
    onDisk({ [`${DESKTOP}/b.png`]: "file" });
    const bed = createBed(),
      dropped = await drop(bed, {
        // The list of VS Code's kind names nothing, so the other is used.
        data: {
          [URI_LIST]: `file://${DESKTOP}/b.png`,
          [VSCODE_URI_LIST]: "untitled:Untitled-1",
        },
        types: [URI_LIST, VSCODE_URI_LIST],
      });

    expect(new Set(dropped.getData.mock.calls)).toEqual(
      new Set([[URI_LIST], [VSCODE_URI_LIST]]),
    );
    expect(dropped.getData).toHaveBeenCalledTimes(2);
    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([]);
  });

  it("keeps to the list of VS Code's kind when both lists name paths", async () => {
    onDisk({ [`${DESKTOP}/b.png`]: "file", [`${DESKTOP}/c.png`]: "file" });
    const bed = createBed();

    await drop(bed, {
      data: {
        [URI_LIST]: `file://${DESKTOP}/c.png`,
        [VSCODE_URI_LIST]: `file://${DESKTOP}/gone.png\r\nfile://${DESKTOP}/b.png`,
      },
      types: [URI_LIST, VSCODE_URI_LIST],
    });

    // Never merged, and no second try with the other list.
    expect(dragAndDropEnvironment.stat.mock.calls).toEqual([
      [`${DESKTOP}/gone.png`],
      [`${DESKTOP}/b.png`],
    ]);
    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("does not take a fragment off a URI of text/uri-list", async () => {
    // A `#` there may as well be part of a name its source did not encode.
    onDisk({ [`${DESKTOP}/b.png`]: "file" });
    const bed = createBed();

    await drop(bed, uriDrag(`file://${DESKTOP}/b.png#L3`));

    expect(dragAndDropEnvironment.stat).not.toHaveBeenCalled();
    expect(bed.paste).not.toHaveBeenCalled();
    expect(notices()).toEqual([NO_PATHS]);
  });

  it.each<readonly [string, () => void]>([
    [
      "is neither a file nor a directory",
      (): void => {
        onDisk({ [`${DESKTOP}/b.png`]: "file", [`${DESKTOP}/gone`]: "socket" });
      },
    ],
    [
      "is missing",
      (): void => {
        onDisk({ [`${DESKTOP}/b.png`]: "file" });
      },
    ],
    [
      "cannot be looked up",
      (): void => {
        dragAndDropEnvironment.stat.mockImplementation((path) => {
          if (path === `${DESKTOP}/gone`) {
            throw new Error("EIO: i/o error");
          }
          return Promise.resolve({
            isDirectory: () => false,
            isFile: () => true,
          });
        });
      },
    ],
  ])(
    "leaves out an entry of a URI list that %s and says so",
    async (_name, arrange) => {
      arrange();
      const bed = createBed();

      await drop(
        bed,
        uriDrag(`file://${DESKTOP}/gone\nfile://${DESKTOP}/b.png`),
      );

      expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
      expect(notices()).toEqual([SKIPPED_PATHS]);
    },
  );

  it("pastes nothing for a URI list of files that are not on disk and says so", async () => {
    const bed = createBed(),
      dropped = await drop(bed, uriDrag());

    expect(bed.paste).not.toHaveBeenCalled();
    expect(bed.focus).not.toHaveBeenCalled();
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(notices()).toEqual([NO_PATHS]);
  });

  it("never looks up a file on a network host", async () => {
    onDisk({ [`${DESKTOP}/b.png`]: "file" });
    const bed = createBed();

    await drop(
      bed,
      uriDrag(`file://server/share/a.png\nfile://${DESKTOP}/b.png`),
    );

    expect(dragAndDropEnvironment.stat.mock.calls).toEqual([
      [`${DESKTOP}/b.png`],
    ]);
    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("pastes nothing for a web link, without letting the drop through", async () => {
    const bed = createBed(),
      dropped = await drop(bed, uriDrag("https://example.com/photo.png"));

    expect(bed.paste).not.toHaveBeenCalled();
    expect(dragAndDropEnvironment.stat).not.toHaveBeenCalled();
    // The browser would navigate to the link.
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(dropped.reachedView).toBe(false);
    expect(notices()).toEqual([NO_PATHS]);
  });

  it("pastes the path of an image dragged out of a note in a pop-out window", async () => {
    // Obsidian makes no draggable there: the drag carries the bitmap as a
    // file without a path, and the URL Obsidian serves the image from.
    dragAndDropEnvironment.webUtils = { getPathForFile: () => "" };
    onDisk({ [`${VAULT}/Assets/photo 1.png`]: "file" });
    const bed = createBed();

    await drop(
      bed,
      nativeDrag([nativeFile("photo 1.png")], {
        data: {
          [URI_LIST]: `${ObsidianPlatform.resourcePathPrefix}Users/me/My%20Vault/Assets/photo%201.png?1712345678901`,
        },
        types: ["Files", URI_LIST, "text/html"],
      }),
    );

    expect(bed.paste.mock.calls).toEqual([
      [`${ESCAPED_VAULT}/Assets/photo\\ 1.png `],
    ]);
    expect(notices()).toEqual([]);
  });

  it("does not add the URI list to files from the system that have paths", async () => {
    onDisk({ [`${DESKTOP}/other.png`]: "file" });
    const bed = createBed();

    await drop(
      bed,
      nativeDrag([nativeFile("b.png", `${DESKTOP}/b.png`)], {
        data: { [URI_LIST]: `file://${DESKTOP}/other.png` },
        types: ["Files", URI_LIST],
      }),
    );

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(dragAndDropEnvironment.stat).not.toHaveBeenCalled();
  });

  // === Looking up a URI list on disk, within bounds ===

  it("looks up four paths of a URI list at a time and pastes in list order", async () => {
    const names = Array.from(
        { length: 10 },
        (_value, index) => `${String(index)}.png`,
      ),
      stats: PendingStat[] = [];
    let inFlight = 0,
      mostInFlight = 0;
    dragAndDropEnvironment.stat.mockImplementation(async () => {
      const stat = pendingStat();
      stats.push(stat);
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      try {
        return await stat.promise;
      } finally {
        --inFlight;
      }
    });
    const bed = createBed();

    await drop(bed, uriDrag(desktopUriList(names)));
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(4);
    // Answered from the newest to the oldest, which is not the list order.
    for (let stat = stats.pop(); stat; stat = stats.pop()) {
      stat.answer();
      await tick();
    }

    expect(mostInFlight).toBe(4);
    expect(dragAndDropEnvironment.stat.mock.calls).toEqual(
      names.map((name) => [`${DESKTOP}/${name}`]),
    );
    expect(bed.paste.mock.calls).toEqual([
      [names.map((name) => `${DESKTOP}/${name} `).join("")],
    ]);
    expect(notices()).toEqual([]);
  });

  it("looks up a short URI list all at once", async () => {
    dragAndDropEnvironment.stat.mockReturnValue(pendingStat().promise);
    const bed = createBed();

    await drop(bed, uriDrag(desktopUriList(["a.png", "b.png"])));

    expect(dragAndDropEnvironment.stat.mock.calls).toEqual([
      [`${DESKTOP}/a.png`],
      [`${DESKTOP}/b.png`],
    ]);
  });

  it("stops waiting for the disk two seconds after it starts on a URI list", async () => {
    vi.useFakeTimers();
    const late: PendingStat[] = [];
    dragAndDropEnvironment.stat.mockImplementation((path) => {
      if (path === `${DESKTOP}/1.png`) {
        return Promise.resolve(FILE_ON_DISK);
      }
      const stat = pendingStat();
      late.push(stat);
      return stat.promise;
    });
    const bed = createBed();

    bed.fire(
      "drop",
      uriDrag(
        desktopUriList(["0.png", "1.png", "2.png", "3.png", "4.png", "5.png"]),
      ),
    );
    await vi.advanceTimersByTimeAsync(1999);
    // `1.png` has its answer, and `4.png` took its place; `5.png` waits.
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(5);
    expect(bed.paste).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/1.png `]]);
    expect(bed.focus).toHaveBeenCalledOnce();
    expect(notices()).toEqual([SKIPPED_PATHS]);

    // Late answers are ignored, and nothing more is looked up: `5.png`, which
    // never got a lookup, is not given the ones that come free now.
    for (const stat of late) {
      stat.answer();
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(5);
    expect(dragAndDropEnvironment.stat).not.toHaveBeenCalledWith(
      `${DESKTOP}/5.png`,
    );
    expect(bed.paste).toHaveBeenCalledOnce();
    expect(notices()).toEqual([SKIPPED_PATHS]);
  });

  it("sets no deadline for a URI list that names no path", async () => {
    vi.useFakeTimers();
    const bed = createBed();

    bed.fire("drop", uriDrag("https://example.com/photo.png"));
    await vi.advanceTimersByTimeAsync(0);

    expect(notices()).toEqual([NO_PATHS]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the deadline once every path of a URI list has its answer", async () => {
    vi.useFakeTimers();
    onDisk({ [`${DESKTOP}/b.png`]: "file" });
    const bed = createBed();

    bed.fire(
      "drop",
      uriDrag(`file://${DESKTOP}/gone\nfile://${DESKTOP}/b.png`),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says there is nothing to insert when the disk has no answer in time", async () => {
    vi.useFakeTimers();
    dragAndDropEnvironment.stat.mockReturnValue(pendingStat().promise);
    const bed = createBed();

    bed.fire("drop", uriDrag());
    await vi.advanceTimersByTimeAsync(2000);

    expect(bed.paste).not.toHaveBeenCalled();
    expect(notices()).toEqual([NO_PATHS]);
  });

  it("takes the next drop once the deadline of a stuck one has passed", async () => {
    vi.useFakeTimers();
    dragAndDropEnvironment.stat.mockImplementation((path) =>
      path === `${DESKTOP}/stuck.png`
        ? pendingStat().promise
        : Promise.resolve(FILE_ON_DISK),
    );
    const bed = createBed();

    bed.fire("drop", uriDrag(`file://${DESKTOP}/stuck.png`));
    bed.fire("drop", uriDrag());
    await vi.advanceTimersByTimeAsync(1999);
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(notices()).toEqual([NO_PATHS]);
  });

  // === Lookups outstanding, over every drop and every terminal ===

  // A `stat` that has no answer goes on after its drop has stopped waiting,
  // and holds a thread of the process until it has one.
  it("starts no fifth lookup for the next drop while four have no answer", async () => {
    vi.useFakeTimers();
    dragAndDropEnvironment.stat.mockImplementation(() => pendingStat().promise);
    const bed = createBed();

    bed.fire(
      "drop",
      uriDrag(
        desktopUriList(["0.png", "1.png", "2.png", "3.png", "4.png", "5.png"]),
      ),
    );
    await vi.advanceTimersByTimeAsync(2000);
    bed.fire("drop", uriDrag(desktopUriList(["6.png", "7.png"])));
    await vi.advanceTimersByTimeAsync(2000);

    expect(dragAndDropEnvironment.stat.mock.calls).toEqual(
      ["0.png", "1.png", "2.png", "3.png"].map((name) => [
        `${DESKTOP}/${name}`,
      ]),
    );
    expect(bed.paste).not.toHaveBeenCalled();
    // The paths of the second drop never got a lookup, and count as skipped.
    expect(notices()).toEqual([NO_PATHS, NO_PATHS]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("looks up a later drop once the lookups before it have their late answers", async () => {
    vi.useFakeTimers();
    const stuck = pendingStatsForEverySlot();
    for (const { promise } of stuck) {
      dragAndDropEnvironment.stat.mockReturnValueOnce(promise);
    }
    dragAndDropEnvironment.stat.mockResolvedValue(FILE_ON_DISK);
    const names = ["a.png", "b.png", "c.png", "d.png", "e.png"],
      bed = createBed();

    bed.fire(
      "drop",
      uriDrag(desktopUriList(["0.png", "1.png", "2.png", "3.png"])),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(notices()).toEqual([NO_PATHS]);
    // The answers come when the drop no longer waits for them.
    for (const stat of stuck) {
      stat.answer();
    }
    await vi.advanceTimersByTimeAsync(0);
    bed.fire("drop", uriDrag(desktopUriList(names)));
    await vi.advanceTimersByTimeAsync(0);

    expect(bed.paste.mock.calls).toEqual([
      [names.map((name) => `${DESKTOP}/${name} `).join("")],
    ]);
    expect(notices()).toEqual([NO_PATHS]);
  });

  it("gives a drop that waits the lookup of the first answer that comes", async () => {
    vi.useFakeTimers();
    const stuck = pendingStatsForEverySlot();
    for (const { promise } of stuck) {
      dragAndDropEnvironment.stat.mockReturnValueOnce(promise);
    }
    dragAndDropEnvironment.stat.mockResolvedValue(FILE_ON_DISK);
    const bed = createBed();

    bed.fire(
      "drop",
      uriDrag(desktopUriList(["0.png", "1.png", "2.png", "3.png"])),
    );
    await vi.advanceTimersByTimeAsync(2000);
    bed.fire("drop", uriDrag(desktopUriList(["a.png", "b.png"])));
    await vi.advanceTimersByTimeAsync(1999);
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(4);

    // One lookup comes free, and the two paths take it in turn.
    stuck[2]?.answer();
    await vi.advanceTimersByTimeAsync(0);

    expect(dragAndDropEnvironment.stat.mock.calls.slice(4)).toEqual([
      [`${DESKTOP}/a.png`],
      [`${DESKTOP}/b.png`],
    ]);
    expect(bed.paste.mock.calls).toEqual([
      [`${DESKTOP}/a.png ${DESKTOP}/b.png `],
    ]);
  });

  it("shares the lookups with the terminals of other addons", async () => {
    vi.useFakeTimers();
    const stuck = pendingStatsForEverySlot();
    for (const { promise } of stuck) {
      dragAndDropEnvironment.stat.mockReturnValueOnce(promise);
    }
    dragAndDropEnvironment.stat.mockResolvedValue(FILE_ON_DISK);
    const first = createBed(),
      second = createBed();

    first.fire(
      "drop",
      uriDrag(desktopUriList(["0.png", "1.png", "2.png", "3.png"])),
    );
    await vi.advanceTimersByTimeAsync(0);
    second.fire("drop", uriDrag());
    await vi.advanceTimersByTimeAsync(1999);
    // The first terminal holds every lookup, so the second one waits.
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(4);
    expect(second.paste).not.toHaveBeenCalled();

    // A lookup comes free when its `stat` answers, and not before: also when
    // the addon it was for is gone by then.
    first.addon.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(4);
    stuck[0]?.answer();
    await vi.advanceTimersByTimeAsync(0);

    expect(dragAndDropEnvironment.stat).toHaveBeenLastCalledWith(
      `${DESKTOP}/b.png`,
    );
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(5);
    expect(second.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(first.paste).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it("says there is nothing to insert when every lookup is held by another terminal for too long", async () => {
    vi.useFakeTimers();
    dragAndDropEnvironment.stat.mockImplementation(() => pendingStat().promise);
    const first = createBed(),
      second = createBed();

    first.fire(
      "drop",
      uriDrag(desktopUriList(["0.png", "1.png", "2.png", "3.png"])),
    );
    await vi.advanceTimersByTimeAsync(1000);
    second.fire("drop", uriDrag());
    await vi.advanceTimersByTimeAsync(1999);
    expect(notices()).toEqual([NO_PATHS]);

    // The second drop has its own two seconds.
    await vi.advanceTimersByTimeAsync(1);
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(4);
    expect(second.paste).not.toHaveBeenCalled();
    expect(notices()).toEqual([NO_PATHS, NO_PATHS]);
  });

  it("looks nothing up for a drop whose addon is disposed while it waits for a lookup", async () => {
    vi.useFakeTimers();
    const stuck = pendingStatsForEverySlot();
    for (const { promise } of stuck) {
      dragAndDropEnvironment.stat.mockReturnValueOnce(promise);
    }
    dragAndDropEnvironment.stat.mockResolvedValue(FILE_ON_DISK);
    const first = createBed(),
      second = createBed(),
      third = createBed();

    first.fire(
      "drop",
      uriDrag(desktopUriList(["0.png", "1.png", "2.png", "3.png"])),
    );
    await vi.advanceTimersByTimeAsync(0);
    second.fire("drop", uriDrag(`file://${DESKTOP}/second.png`));
    await vi.advanceTimersByTimeAsync(0);
    second.addon.dispose();
    stuck[0]?.answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(dragAndDropEnvironment.stat).toHaveBeenCalledTimes(4);

    // The lookup it was handed is free for the next drop.
    third.fire("drop", uriDrag());
    await vi.advanceTimersByTimeAsync(0);

    expect(dragAndDropEnvironment.stat).toHaveBeenLastCalledWith(
      `${DESKTOP}/b.png`,
    );
    expect(third.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(second.paste).not.toHaveBeenCalled();
  });

  // === Focus after a drop ===

  it("leaves the focus where it went while a URI list was looked up", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed(),
      note = focusable();

    await drop(bed, uriDrag());
    // The disk is slow, and the user goes on to write in a note.
    note.focus();
    stat.answer();
    await tick();

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(bed.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(note);
  });

  it("focuses the terminal when the focus was elsewhere at the drop and has not moved since", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed(),
      note = focusable();

    note.focus();
    expect(document.activeElement).toBe(note);
    await drop(bed, uriDrag());
    stat.answer();
    await tick();

    expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    expect(bed.focus).toHaveBeenCalledOnce();
  });

  it("leaves the focus where it went while an earlier drop was looked up", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed(),
      note = focusable();

    await drop(bed, uriDrag());
    // Files from the system need no lookup, but wait their turn.
    await drop(bed, nativeDrag([nativeFile("c.png", `${DESKTOP}/c.png`)]));
    note.focus();
    stat.answer();
    await tick();

    expect(bed.paste.mock.calls).toEqual([
      [`${DESKTOP}/b.png `],
      [`${DESKTOP}/c.png `],
    ]);
    expect(bed.focus).not.toHaveBeenCalled();
  });

  it("reads the focus of the window the terminal is in", async () => {
    const bed = createBed({ document: popoutDocument() }),
      note = focusable();

    bed.fire("drop", nativeDrag());
    // In the main window, which is not where the terminal is.
    note.focus();
    await tick();

    expect(bed.focus).toHaveBeenCalledOnce();
  });

  // === Drops one after another ===

  it("pastes a drop that needs no lookup after an earlier one that does", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed();

    await drop(bed, uriDrag());
    bed.dragManager.draggable = fileDraggable("a.png");
    await drop(bed, vaultDrag());
    bed.dragManager.draggable = null;
    await drop(bed, nativeDrag([nativeFile("c.png", `${DESKTOP}/c.png`)]));
    expect(bed.paste).not.toHaveBeenCalled();
    stat.answer();
    await tick();

    expect(bed.paste.mock.calls).toEqual([
      [`${DESKTOP}/b.png `],
      [`${ESCAPED_VAULT}/a.png `],
      [`${DESKTOP}/c.png `],
    ]);
  });

  it("shows the notice of each drop in drop order", async () => {
    const stat = pendingStat();
    dragAndDropEnvironment.stat.mockReturnValue(stat.promise);
    const bed = createBed({
      draggable: {
        files: [vaultFile("gone.md"), vaultFile("here.md")],
        type: "files",
      },
      missing: ["gone.md"],
    });

    // A vault drag wins over the URI list it carries, so the draggable is
    // taken away for the first drop.
    const { draggable } = bed.dragManager;
    bed.dragManager.draggable = null;
    await drop(bed, uriDrag());
    bed.dragManager.draggable = draggable;
    await drop(bed, vaultDrag());
    stat.answer({ isDirectory: () => false, isFile: () => false });
    await tick();

    expect(notices()).toEqual([NO_PATHS, SKIPPED_PATHS]);
  });

  it("still takes a drop after one that failed", async () => {
    const failure = new Error("terminal is busy"),
      error = vi.spyOn(console, "error").mockImplementation(noop),
      bed = createBed();
    bed.paste.mockImplementationOnce(() => {
      throw failure;
    });

    await drop(bed, nativeDrag());
    await drop(bed, nativeDrag([nativeFile("c.png", `${DESKTOP}/c.png`)]));

    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(bed.paste.mock.calls).toEqual([
      [`${DESKTOP}/b.png `],
      [`${DESKTOP}/c.png `],
    ]);
  });

  // === Drags out of VS Code and Edge, as measured on Windows ===

  describe("on Windows, with PowerShell", () => {
    /** Sets up the disk of the measured drags and a PowerShell terminal. */
    function createWindowsBed(): Bed {
      dragAndDropEnvironment.platform = "win32";
      // VS Code has no files in its data transfer; Edge has one for an image.
      dragAndDropEnvironment.webUtils = { getPathForFile: () => "" };
      onDisk({
        [`${WINDOWS_FOLDER}\\.obsidian\\workspace.json`]: "file",
        [`${WINDOWS_FOLDER}\\Images\\photo space.jpg`]: "file",
        [`${WINDOWS_FOLDER}\\Images\\photo.png`]: "file",
        [`${WINDOWS_FOLDER}\\Images\\second.png`]: "file",
        [`${WINDOWS_FOLDER}\\Notes`]: "directory",
        [`${WINDOWS_FOLDER}\\Notes\\Plain.md`]: "file",
        [`${WINDOWS_FOLDER}\\manifest.fixtures.json`]: "file",
      });
      return createBed({ executable: "powershell.exe" });
    }

    it.each<readonly [string, DragInit, readonly string[]]>([
      [
        "a file of VS Code's tree",
        vscodeDrag(VSCODE_TREE_TYPES, {
          [TEXT]: `${WINDOWS_FOLDER}\\Images\\photo.png`,
          [URI_LIST]: `${VSCODE_FOLDER}/Images/photo.png`,
          [VSCODE_URI_LIST]: `${VSCODE_FOLDER}/Images/photo.png`,
        }),
        [`${WINDOWS_FOLDER}\\Images\\photo.png `],
      ],
      [
        "a file of VS Code's tree with a space in its name",
        vscodeDrag(VSCODE_TREE_TYPES, {
          [TEXT]: `${WINDOWS_FOLDER}\\Images\\photo space.jpg`,
          [URI_LIST]: `${VSCODE_FOLDER}/Images/photo%20space.jpg`,
          [VSCODE_URI_LIST]: `${VSCODE_FOLDER}/Images/photo%20space.jpg`,
        }),
        [`'${WINDOWS_FOLDER}\\Images\\photo space.jpg' `],
      ],
      [
        // `text/uri-list` has only the first of them.
        "two files of VS Code's tree, each on its own",
        vscodeDrag(VSCODE_TREE_TYPES, {
          [TEXT]: `${WINDOWS_FOLDER}\\Images\\photo.png\r\n${WINDOWS_FOLDER}\\Images\\second.png`,
          [URI_LIST]: `${VSCODE_FOLDER}/Images/photo.png`,
          [VSCODE_URI_LIST]: `${VSCODE_FOLDER}/Images/photo.png\r\n${VSCODE_FOLDER}/Images/second.png`,
        }),
        [
          `${WINDOWS_FOLDER}\\Images\\photo.png `,
          `${WINDOWS_FOLDER}\\Images\\second.png `,
        ],
      ],
      [
        "a folder and a file of VS Code's tree, each on its own",
        vscodeDrag(VSCODE_TREE_TYPES, {
          [TEXT]: `${WINDOWS_FOLDER}\\manifest.fixtures.json\r\n${WINDOWS_FOLDER}\\Notes`,
          [URI_LIST]: `${VSCODE_FOLDER}/Notes`,
          [VSCODE_URI_LIST]: `${VSCODE_FOLDER}/Notes\r\n${VSCODE_FOLDER}/manifest.fixtures.json`,
        }),
        [
          `${WINDOWS_FOLDER}\\Notes `,
          `${WINDOWS_FOLDER}\\manifest.fixtures.json `,
        ],
      ],
      [
        // No `text/uri-list` and no `text/plain` at all.
        "an editor tab of VS Code",
        vscodeDrag(
          [
            "resourceurls",
            "chromium/x-drag-id",
            "codeeditors",
            VSCODE_URI_LIST,
          ],
          { [VSCODE_URI_LIST]: `${VSCODE_FOLDER}/Notes/Plain.md` },
        ),
        [`${WINDOWS_FOLDER}\\Notes\\Plain.md `],
      ],
      [
        // The place of the match comes as a fragment, in both lists.
        "a match in VS Code's search results",
        vscodeDrag(
          [
            TEXT,
            URI_LIST,
            "resourceurls",
            "chromium/x-drag-id",
            "codeeditors",
            VSCODE_URI_LIST,
          ],
          {
            [TEXT]: `${WINDOWS_FOLDER}\\.obsidian\\workspace.json`,
            [URI_LIST]: `${VSCODE_FOLDER}/.obsidian/workspace.json#251%2C29-251%2C34`,
            [VSCODE_URI_LIST]: `${VSCODE_FOLDER}/.obsidian/workspace.json#251%2C29-251%2C34`,
          },
        ),
        [`${WINDOWS_FOLDER}\\.obsidian\\workspace.json `],
      ],
      [
        "a link to a file in a page of Edge",
        {
          data: {
            [TEXT]: `${EDGE_FOLDER}/Notes/Plain.md`,
            [URI_LIST]: `${EDGE_FOLDER}/Notes/Plain.md`,
          },
          effectAllowed: "all",
          types: EDGE_TYPES,
        },
        [`${WINDOWS_FOLDER}\\Notes\\Plain.md `],
      ],
      [
        // The image itself comes as a file without a path.
        "an image of a file in a page of Edge",
        {
          data: {
            [TEXT]: `${EDGE_FOLDER}/Images/photo.png`,
            [URI_LIST]: `${EDGE_FOLDER}/Images/photo.png`,
          },
          effectAllowed: "all",
          files: [nativeFile("photo.png", "")],
          types: [...EDGE_TYPES, "Files"],
        },
        [`${WINDOWS_FOLDER}\\Images\\photo.png `],
      ],
    ])("pastes %s", async (_name, init, expected) => {
      const bed = createWindowsBed(),
        entered = bed.fire("dragenter", init),
        over = bed.fire("dragover", init),
        dropped = await drop(bed, init);

      for (const accepted of [entered, over]) {
        expect(accepted.event.defaultPrevented).toBe(true);
        expect(accepted.dataTransfer?.dropEffect).toBe("copy");
      }
      expect(bed.paste.mock.calls).toEqual(expected.map((text) => [text]));
      expect(bed.focus).toHaveBeenCalledOnce();
      expect(dropped.event.defaultPrevented).toBe(true);
      expect(dropped.reachedView).toBe(false);
      expect(notices()).toEqual([]);
    });

    it.each<readonly [string, DragInit]>([
      [
        "an untitled editor tab of VS Code",
        vscodeDrag(["codeeditors", VSCODE_URI_LIST, "chromium/x-drag-id"], {
          [VSCODE_URI_LIST]: "untitled:Untitled-1",
        }),
      ],
      [
        "a link to a web page in a page of Edge",
        {
          data: {
            [TEXT]: "https://example.com/some%20path/page?x=1&y=2#frag",
            [URI_LIST]: "https://example.com/some%20path/page?x=1&y=2#frag",
          },
          effectAllowed: "all",
          types: EDGE_TYPES,
        },
      ],
    ])(
      "pastes nothing for %s and says so, without letting the drop through",
      async (_name, init) => {
        const bed = createWindowsBed(),
          dropped = await drop(bed, init);

        expect(bed.paste).not.toHaveBeenCalled();
        expect(bed.focus).not.toHaveBeenCalled();
        expect(dragAndDropEnvironment.stat).not.toHaveBeenCalled();
        // VS Code would open the tab in a window of its own all the same, and
        // the browser would follow the link.
        expect(dropped.event.defaultPrevented).toBe(true);
        expect(dropped.reachedView).toBe(false);
        expect(notices()).toEqual([NO_PATHS]);
      },
    );
  });

  // === Without Electron or a file system ===

  describe("where Electron cannot be required, as on mobile", () => {
    it("pastes a file from the system by its legacy File.path", async () => {
      dragAndDropEnvironment.electron = false;
      const bed = createBed({ Addon: await loadAddon() });

      await drop(bed, nativeDrag([nativeFile("b.png", `${DESKTOP}/b.png`)]));

      expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
      expect(notices()).toEqual([]);
    });

    it("pastes nothing for a file without a path and says so", async () => {
      dragAndDropEnvironment.electron = false;
      const bed = createBed({ Addon: await loadAddon() }),
        dropped = await drop(bed, nativeDrag([nativeFile("image.png")]));

      expect(bed.paste).not.toHaveBeenCalled();
      expect(dropped.event.defaultPrevented).toBe(true);
      expect(notices()).toEqual([NO_PATHS]);
    });
  });

  describe("where the file system cannot be required", () => {
    it("leaves out every entry of a URI list and says so", async () => {
      dragAndDropEnvironment.fileSystem = false;
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const bed = createBed({ Addon: await loadAddon() }),
          dropped = await drop(
            bed,
            uriDrag(desktopUriList(["a.png", "b.png"])),
          );
        // Node reports a rejection nobody handled after the microtasks of a tick.
        await tick();

        expect(bed.paste).not.toHaveBeenCalled();
        expect(dragAndDropEnvironment.stat).not.toHaveBeenCalled();
        expect(dropped.event.defaultPrevented).toBe(true);
        expect(notices()).toEqual([NO_PATHS]);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("still pastes files from the system", async () => {
      dragAndDropEnvironment.fileSystem = false;
      const bed = createBed({ Addon: await loadAddon() });

      await drop(bed, nativeDrag());

      expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    });
  });

  // === One paste for a drop, or one for each path ===

  // Measured on macOS with zsh: sixteen and nineteen paths, each a paste of
  // its own, hung the terminal for good, and one paste of fifty-seven paths
  // was read whole.
  it.each<readonly [string, string, string]>([
    ["macOS", "darwin", "/bin/zsh"],
    ["Linux", "linux", "/bin/bash"],
  ])(
    "pastes several paths as one paste on %s",
    async (_name, platform, executable) => {
      dragAndDropEnvironment.platform = platform;
      const numbers = Array.from({ length: 19 }, (_value, index) =>
          String(index),
        ),
        bed = createBed({ executable });

      await drop(
        bed,
        nativeDrag(
          numbers.map((number) =>
            nativeFile("shot.png", `${DESKTOP}/shot ${number}.png`),
          ),
        ),
      );

      expect(bed.paste.mock.calls).toEqual([
        [numbers.map((number) => `${DESKTOP}/shot\\ ${number}.png `).join("")],
      ]);
      expect(bed.focus).toHaveBeenCalledOnce();
      expect(notices()).toEqual([]);
    },
  );

  // Claude Code tells quoted paths apart only when each is a paste of its own.
  it("pastes several paths as one paste each on Windows", async () => {
    dragAndDropEnvironment.platform = "win32";
    const numbers = Array.from({ length: 19 }, (_value, index) =>
        String(index),
      ),
      bed = createBed({ executable: "powershell.exe" });

    await drop(
      bed,
      nativeDrag(
        numbers.map((number) =>
          nativeFile("shot.png", `C:\\Users\\me\\Desktop\\shot ${number}.png`),
        ),
      ),
    );

    expect(bed.paste.mock.calls).toEqual(
      numbers.map((number) => [
        `'C:\\Users\\me\\Desktop\\shot ${number}.png' `,
      ]),
    );
    expect(bed.focus).toHaveBeenCalledOnce();
    expect(notices()).toEqual([]);
  });

  it.each<readonly [string, string, string, string, string]>([
    [
      "macOS",
      "darwin",
      "/bin/zsh",
      `${DESKTOP}/shot 1.png`,
      `${DESKTOP}/shot\\ 1.png `,
    ],
    [
      "Linux",
      "linux",
      "/bin/bash",
      "/home/me/shot 1.png",
      "/home/me/shot\\ 1.png ",
    ],
    [
      "Windows",
      "win32",
      "powershell.exe",
      "C:\\Users\\me\\Desktop\\shot 1.png",
      "'C:\\Users\\me\\Desktop\\shot 1.png' ",
    ],
    [
      "Windows under WSL, as the Linux path",
      "win32",
      "C:\\Windows\\System32\\wsl.exe",
      "C:\\Users\\me\\Desktop\\shot 1.png",
      "/mnt/c/Users/me/Desktop/shot\\ 1.png ",
    ],
  ])(
    "pastes a single path as one paste of that path on %s",
    async (_name, platform, executable, path, pasted) => {
      dragAndDropEnvironment.platform = platform;
      const bed = createBed({ executable });

      await drop(bed, nativeDrag([nativeFile("shot 1.png", path)]));

      expect(bed.paste.mock.calls).toEqual([[pasted]]);
      expect(bed.focus).toHaveBeenCalledOnce();
      expect(notices()).toEqual([]);
    },
  );

  // === Quoting for the shell of the profile ===

  // The pastes of two paths: one off Windows, and one for each path on it.
  it.each<readonly [string, string, string, string, readonly string[]]>([
    [
      "zsh on macOS",
      "darwin",
      "/bin/zsh",
      "/Users/me/Vault/",
      ["/Users/me/Vault/Assets/photo\\ 1.png /Users/me/Vault/b.png "],
    ],
    [
      "an unknown program on Linux",
      "linux",
      "",
      "/home/me/Vault/",
      ["/home/me/Vault/Assets/photo\\ 1.png /home/me/Vault/b.png "],
    ],
    [
      "PowerShell on Windows",
      "win32",
      "powershell",
      "C:\\Users\\me\\Vault\\",
      [
        "'C:\\Users\\me\\Vault\\Assets\\photo 1.png' ",
        "C:\\Users\\me\\Vault\\b.png ",
      ],
    ],
    [
      "Command Prompt",
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Users\\me\\Vault\\",
      [
        '"C:\\Users\\me\\Vault\\Assets\\photo 1.png" ',
        "C:\\Users\\me\\Vault\\b.png ",
      ],
    ],
    [
      "Git Bash",
      "win32",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Users\\me\\Vault\\",
      [
        "'C:\\Users\\me\\Vault\\Assets\\photo 1.png' ",
        "'C:\\Users\\me\\Vault\\b.png' ",
      ],
    ],
    [
      "WSL, as Linux paths",
      "win32",
      "C:\\Windows\\System32\\wsl.exe",
      "C:\\Users\\me\\Vault\\",
      [
        "/mnt/c/Users/me/Vault/Assets/photo\\ 1.png ",
        "/mnt/c/Users/me/Vault/b.png ",
      ],
    ],
    [
      "an unknown program on Windows",
      "win32",
      "",
      "C:\\Users\\me\\Vault\\",
      [
        '"C:\\Users\\me\\Vault\\Assets\\photo 1.png" ',
        "C:\\Users\\me\\Vault\\b.png ",
      ],
    ],
  ])(
    "writes vault paths for %s",
    async (_name, platform, executable, root, pastes) => {
      dragAndDropEnvironment.platform = platform;
      const bed = createBed({
        draggable: {
          files: [vaultFile("Assets/photo 1.png"), vaultFile("b.png")],
          type: "files",
        },
        executable,
        fullPath: (path) =>
          root + (platform === "win32" ? path.replaceAll("/", "\\") : path),
      });

      await drop(bed, vaultDrag());

      expect(bed.paste.mock.calls).toEqual(pastes.map((paste) => [paste]));
    },
  );

  it("writes a file URI on Windows as a drive path for the shell", async () => {
    dragAndDropEnvironment.platform = "win32";
    onDisk({ "C:\\Users\\me\\My Pictures\\a.png": "file" });
    const bed = createBed({ executable: "pwsh.exe" });

    await drop(bed, uriDrag("file:///C:/Users/me/My%20Pictures/a.png"));

    expect(bed.paste.mock.calls).toEqual([
      ["'C:\\Users\\me\\My Pictures\\a.png' "],
    ]);
  });

  it("writes files from the system on Windows for the shell", async () => {
    dragAndDropEnvironment.platform = "win32";
    const bed = createBed({ executable: "C:\\Windows\\System32\\cmd.exe" });

    await drop(
      bed,
      nativeDrag([nativeFile("a b.png", "C:\\Users\\me\\Desktop\\a b.png")]),
    );

    expect(bed.paste.mock.calls).toEqual([
      ['"C:\\Users\\me\\Desktop\\a b.png" '],
    ]);
  });

  // === Notices ===

  it("shows its notices as the plugin's other notices are shown", async () => {
    const bed = createBed();

    await drop(bed, nativeDrag([nativeFile("image.png")]));

    expect(notice2).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      NOTICE_TIMEOUT,
      bed.context,
    );
  });

  // === Obsidian without the private drag manager ===

  describe.each<readonly [string, Readonly<Record<string, unknown>>]>([
    ["no drag manager", {}],
    ["a null drag manager", { dragManager: null }],
    ["a drag manager that is not an object", { dragManager: "manager" }],
    ["a drag manager without a draggable", { dragManager: {} }],
    ["an undefined draggable", { dragManager: { draggable: void 0 } }],
  ])("in an app with %s", (_name, app) => {
    it.each(DRAG_TYPES)(
      "leaves %s of a vault drag untouched without throwing",
      async (type) => {
        const bed = createBed({ app }),
          fired = bed.fire(type, vaultDrag());
        await tick();

        expect(fired.event.defaultPrevented).toBe(false);
        expect(fired.reachedView).toBe(true);
        expect(bed.paste).not.toHaveBeenCalled();
      },
    );

    it("still pastes files from the system", async () => {
      const bed = createBed({ app });

      await drop(bed, nativeDrag());

      expect(bed.paste.mock.calls).toEqual([[`${DESKTOP}/b.png `]]);
    });
  });
});

describe("FollowThemeAddon.refresh", () => {
  it("is callable after activate", () => {
    expect(FollowThemeAddon.prototype).toHaveProperty("refresh");
    expect(typeof FollowThemeAddon.prototype.refresh).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// SynchronizedOutputScrollAddon
// ---------------------------------------------------------------------------

/**
 * Minimal mock Terminal for SynchronizedOutputScrollAddon tests.
 *
 * Captures CSI handlers registered via `parser.registerCsiHandler()` keyed by
 * `"<prefix><final>"` so tests can fire them directly, simulating xterm.js
 * dispatching the DEC 2026 begin/end synchronized-output sequences.
 */
function createSyncMockTerminal(
  initialViewportY = 0,
  initialBaseY = 0,
): {
  terminal: Terminal;
  scrollToBottomSpy: ReturnType<typeof vi.fn>;
  scrollToLineSpy: ReturnType<typeof vi.fn>;
  setBuffer: (viewportY: number, baseY: number) => void;
  triggerCsi: (prefix: string, final: string, params: number[]) => boolean[];
} {
  const handlers: Record<
    string,
    Array<(params: { [index: number]: number }) => boolean>
  > = {};

  const scrollToBottomSpy = vi.fn();
  const scrollToLineSpy = vi.fn();

  let viewportY = initialViewportY;
  let baseY = initialBaseY;

  const terminal = {
    parser: {
      registerCsiHandler(
        id: { prefix?: string; final: string },
        handler: (params: { [index: number]: number }) => boolean,
      ): IDisposable {
        const key = `${id.prefix ?? ""}${id.final}`;
        const bucket = (handlers[key] ??= []);
        bucket.push(handler);
        return { dispose: vi.fn() };
      },
    },
    buffer: {
      get active() {
        return { viewportY, baseY };
      },
    },
    scrollToBottom: scrollToBottomSpy,
    scrollToLine: scrollToLineSpy,
  } as unknown as Terminal;

  return {
    terminal,
    scrollToBottomSpy,
    scrollToLineSpy,
    setBuffer(vY: number, bY: number) {
      viewportY = vY;
      baseY = bY;
    },
    triggerCsi(prefix: string, final: string, params: number[]): boolean[] {
      const key = `${prefix}${final}`;
      return (handlers[key] ?? []).map((h) =>
        h(params as unknown as { [index: number]: number }),
      );
    },
  };
}

describe("SynchronizedOutputScrollAddon", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls scrollToBottom() after sync block when user was at bottom", async () => {
    // viewportY == baseY → at bottom
    const { terminal, scrollToBottomSpy, triggerCsi } = createSyncMockTerminal(
      10,
      10,
    );
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    // Begin sync block
    triggerCsi("?", "h", [2026]);
    // End sync block
    triggerCsi("?", "l", [2026]);

    expect(scrollToBottomSpy).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(scrollToBottomSpy).toHaveBeenCalledOnce();
  });

  it("calls scrollToLine() with delta-adjusted position when user was scrolled up", async () => {
    // viewportY(5) < baseY(10) → scrolled up 5 lines from bottom page
    const mock = createSyncMockTerminal(5, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(mock.terminal);

    // Begin sync; simulate ED2 growing baseY by 20 during the block
    mock.triggerCsi("?", "h", [2026]);
    mock.setBuffer(30, 30); // after ED2 + redraw: baseY grew from 10 → 30
    mock.triggerCsi("?", "l", [2026]);

    await Promise.resolve();
    // Expected: viewportY 5 + delta(20) = 25, clamped to baseY(30)
    expect(mock.scrollToLineSpy).toHaveBeenCalledWith(25);
    expect(mock.scrollToBottomSpy).not.toHaveBeenCalled();
  });

  it("clamps restored viewportY to [0, baseY]", async () => {
    // viewportY(3) < baseY(5) → scrolled up
    const mock = createSyncMockTerminal(3, 5);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(mock.terminal);

    mock.triggerCsi("?", "h", [2026]);
    // baseY shrinks (unlikely but defensive): 5 → 0
    mock.setBuffer(0, 0);
    mock.triggerCsi("?", "l", [2026]);

    await Promise.resolve();
    // vY(3) + delta(-5) = -2 → clamped to 0
    expect(mock.scrollToLineSpy).toHaveBeenCalledWith(0);
  });

  it("only snapshots scroll state at the outermost sync block entry (nested blocks)", async () => {
    // At bottom
    const mock = createSyncMockTerminal(10, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(mock.terminal);

    // Outer begin
    mock.triggerCsi("?", "h", [2026]);
    // Inner begin (depth becomes 2 — state must NOT be re-snapshotted here)
    mock.setBuffer(5, 10); // simulate state change before inner begin
    mock.triggerCsi("?", "h", [2026]);
    // Inner end (depth back to 1 — must NOT restore yet)
    mock.triggerCsi("?", "l", [2026]);
    await Promise.resolve();
    expect(mock.scrollToBottomSpy).not.toHaveBeenCalled();

    // Outer end (depth back to 0 — must restore now)
    mock.setBuffer(10, 10);
    mock.triggerCsi("?", "l", [2026]);
    await Promise.resolve();
    // Original snapshot was atBottom=true (viewportY 10 >= baseY 10)
    expect(mock.scrollToBottomSpy).toHaveBeenCalledOnce();
  });

  it("ignores ?2026l without a preceding ?2026h", async () => {
    const { terminal, scrollToBottomSpy, scrollToLineSpy, triggerCsi } =
      createSyncMockTerminal(0, 0);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    // End without begin — must be a no-op
    triggerCsi("?", "l", [2026]);
    await Promise.resolve();
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
    expect(scrollToLineSpy).not.toHaveBeenCalled();
  });

  it("does not interfere with unrelated CSI ?h/?l sequences", async () => {
    const { terminal, scrollToBottomSpy, scrollToLineSpy, triggerCsi } =
      createSyncMockTerminal(10, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    // ?1049h / ?1049l are alt-screen sequences — must be ignored
    triggerCsi("?", "h", [1049]);
    triggerCsi("?", "l", [1049]);
    await Promise.resolve();
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
    expect(scrollToLineSpy).not.toHaveBeenCalled();
  });

  it("returns false from both handlers so xterm processes sequences normally", () => {
    // Capture return values by overriding triggerCsi to return them
    const returnVals: boolean[] = [];
    const origHandlers: Record<
      string,
      Array<(params: { [index: number]: number }) => boolean>
    > = {};
    const patchedTerminal = {
      buffer: { active: { baseY: 0, viewportY: 0 } },
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      parser: {
        registerCsiHandler(
          id: { prefix?: string; final: string },
          handler: (params: { [index: number]: number }) => boolean,
        ): IDisposable {
          const key = `${id.prefix ?? ""}${id.final}`;
          const bucket = (origHandlers[key] ??= []);
          bucket.push(handler);
          return { dispose: vi.fn() };
        },
      },
    } as unknown as Terminal;

    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(patchedTerminal);

    const fakeParams = [2026] as unknown as { [index: number]: number };
    for (const h of origHandlers["?h"] ?? []) {
      returnVals.push(h(fakeParams));
    }
    for (const h of origHandlers["?l"] ?? []) {
      returnVals.push(h(fakeParams));
    }
    expect(returnVals).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// VaultFileLinksAddon
// ---------------------------------------------------------------------------

describe("VaultFileLinksAddon", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Mock file returned by getFileByPath. */
  const MOCK_FILE: TFile = {
    basename: "test",
    extension: "md",
    name: "test.md",
    parent: null,
    path: "test.md",
    stat: { ctime: 0, mtime: 0, size: 0 },
    vault: {} as Vault,
  };

  /**
   * Creates a VaultFileLinksAddon test bed.
   *
   * @param fileExists - Whether getFileByPath should return a TFile or null.
   */
  function createBed(fileExists = true): {
    provideLinks: (lineText: string) => ILink[] | undefined;
    getFileByPath: ReturnType<typeof vi.fn>;
    openFile: ReturnType<typeof vi.fn>;
    getLeaf: ReturnType<typeof vi.fn>;
    disposable: IDisposable;
    addon: VaultFileLinksAddon;
  } {
    const getFileByPath = vi.fn(() => (fileExists ? MOCK_FILE : null));
    const vault = { getFileByPath } as unknown as Vault;

    const openFile = vi.fn().mockResolvedValue(undefined);
    const getLeaf = vi.fn(() => ({ openFile }) as unknown as WorkspaceLeaf);
    const workspace = { getLeaf } as unknown as Workspace;

    const app = { vault, workspace } as unknown as App;
    const context = { app } as unknown as PluginContext;

    const addon = new VaultFileLinksAddon(context);

    let capturedProvider: ILinkProvider | undefined;
    const disposable = { dispose: vi.fn() };
    const registerLinkProvider = vi.fn((p: ILinkProvider) => {
      capturedProvider = p;
      return disposable;
    });

    const getLine = vi.fn();
    const terminal = {
      registerLinkProvider,
      buffer: { active: { getLine } },
      element: document.createElement("div"),
    } as unknown as Terminal;

    addon.activate(terminal);

    function provideLinks(lineText: string): ILink[] | undefined {
      let result: ILink[] | undefined;
      const line = { translateToString: vi.fn(() => lineText) };
      getLine.mockReturnValue(line);
      capturedProvider?.provideLinks(1, (links) => {
        result = links;
      });
      return result;
    }

    return {
      provideLinks,
      getFileByPath,
      openFile,
      getLeaf,
      disposable,
      addon,
    };
  }

  // --- Parenthesized links ---

  it("finds parenthesized .md links", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("See (test.md) for details");
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("test.md");
  });

  it("finds parenthesized .md links with spaces", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("Open (my notes/file.md) here");
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("my notes/file.md");
  });

  it("filters bare sub-matches inside parenthesized paths", () => {
    const { provideLinks } = createBed();
    // The bare regex would match "notes/file.md" as a sub-path, but it falls
    // inside paren range of "my notes/file.md", so only 1 link is produced.
    const links = provideLinks("(my notes/file.md)");
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("my notes/file.md");
  });

  it("ignores parenthesized text without .md extension", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("(test.txt)");
    expect(links).toHaveLength(0);
  });

  // --- Bare links ---

  it("finds bare .md links after whitespace", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("see docs/file.md for info");
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("docs/file.md");
  });

  it("finds bare .md links at line start", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("file.md is here");
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("file.md");
  });

  it("finds bare .md links after an opening quote", () => {
    const { provideLinks } = createBed();
    const links = provideLinks('read "docs/file.md" here');
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("docs/file.md");
  });

  it("does not include preceding space or quote in link text", () => {
    const { provideLinks } = createBed();
    const withSpace = provideLinks("see docs/file.md now");
    expect(withSpace).toHaveLength(1);
    expect(withSpace?.[0]?.text).toBe("docs/file.md");

    const withQuote = provideLinks('"docs/file.md"');
    expect(withQuote).toHaveLength(1);
    expect(withQuote?.[0]?.text).toBe("docs/file.md");
  });

  // --- Multiple links ---

  it("finds multiple parenthesized links on one line", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("(a.md) and (b.md)");
    expect(links).toHaveLength(2);
    expect(links?.[0]?.text).toBe("a.md");
    expect(links?.[1]?.text).toBe("b.md");
  });

  it("finds mixed bare and parenthesized links", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("(a.md) and b.md");
    expect(links).toHaveLength(2);
    expect(links?.[0]?.text).toBe("a.md");
    expect(links?.[1]?.text).toBe("b.md");
  });

  // --- No-match cases ---

  it("returns empty array for a line with no .md links", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("Just some plain text");
    expect(links).toHaveLength(0);
  });

  it("returns empty array for empty line", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("");
    expect(links).toHaveLength(0);
  });

  // --- File resolution ---

  it("calls getFileByPath for each matched link", () => {
    const { provideLinks, getFileByPath } = createBed();
    provideLinks("(a.md) and (b.md)");
    expect(getFileByPath).toHaveBeenCalledTimes(2);
    expect(getFileByPath).toHaveBeenCalledWith("a.md");
    expect(getFileByPath).toHaveBeenCalledWith("b.md");
  });

  it("omits links whose files do not exist", () => {
    const { provideLinks } = createBed(false);
    const links = provideLinks("(test.md)");
    expect(links).toHaveLength(0);
  });

  // --- Activation ---

  it("activates by opening the file in Obsidian", () => {
    const { provideLinks, openFile, getLeaf } = createBed();
    const links = provideLinks("(test.md)");
    expect(links).toHaveLength(1);

    links?.[0]?.activate({} as MouseEvent, "test.md");
    expect(getLeaf).toHaveBeenCalledWith(false);
    expect(openFile).toHaveBeenCalledWith(MOCK_FILE);
  });

  it("logs to console.error when openFile rejects", async () => {
    const getFileByPath = vi.fn(() => MOCK_FILE);
    const vault = { getFileByPath } as unknown as Vault;

    const consoleError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(consoleError);

    const openFile = vi.fn().mockRejectedValue(new Error("fail"));
    const getLeaf = vi.fn(() => ({ openFile }) as unknown as WorkspaceLeaf);
    const workspace = { getLeaf } as unknown as Workspace;
    const app = { vault, workspace } as unknown as App;
    const context = { app } as unknown as PluginContext;
    const addon = new VaultFileLinksAddon(context);

    let capturedProvider: ILinkProvider | undefined;
    const getLine = vi.fn();
    const terminal = {
      registerLinkProvider: vi.fn((p: ILinkProvider) => {
        capturedProvider = p;
        return { dispose: vi.fn() };
      }),
      buffer: { active: { getLine } },
      element: document.createElement("div"),
    } as unknown as Terminal;
    addon.activate(terminal);

    const line = { translateToString: vi.fn(() => "(test.md)") };
    getLine.mockReturnValue(line);
    let result: ILink[] | undefined;
    capturedProvider?.provideLinks(1, (links) => {
      result = links;
    });

    result?.[0]?.activate({} as MouseEvent, "test.md");

    await Promise.resolve();
    expect(consoleError).toHaveBeenCalled();
  });

  // --- Disposal ---

  it("dispose() disposes the registered link provider", () => {
    const disposer = { dispose: vi.fn() };
    const registerLinkProvider = vi.fn(() => disposer);
    const terminal = {
      registerLinkProvider,
      buffer: { active: { getLine: vi.fn() } },
      element: document.createElement("div"),
    } as unknown as Terminal;

    const getFileByPath = vi.fn();
    const vault = { getFileByPath } as unknown as Vault;
    const app = { vault, workspace: {} as Workspace } as unknown as App;
    const context = { app } as unknown as PluginContext;
    const addon = new VaultFileLinksAddon(context);
    addon.activate(terminal);

    addon.dispose();
    expect(disposer.dispose).toHaveBeenCalled();
  });

  // --- Link range x-coordinates ---

  it("computes correct x-range for link at line start", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("(file.md)");
    expect(links).toHaveLength(1);
    // `(` is column 1, `f` starts at column 2.
    expect(links?.[0]?.range.start.x).toBe(2);
    // `(` + `file.md` = 8 visual columns (all ASCII).
    expect(links?.[0]?.range.end.x).toBe(8);
  });

  it("computes correct x-range for link after ASCII text", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("see (file.md) here");
    expect(links).toHaveLength(1);
    // `see ` is 4 columns, `(` is column 5, `f` starts at column 6.
    expect(links?.[0]?.range.start.x).toBe(6);
    // `see (file.md` = 12 visual columns (all ASCII).
    expect(links?.[0]?.range.end.x).toBe(12);
  });

  it("accounts for double-width characters in x-range", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("中文(content.md)");
    expect(links).toHaveLength(1);
    // `中` = 2 columns, `文` = 2 columns, `(` = 1 column → `f` at column 6.
    expect(links?.[0]?.range.start.x).toBe(6);
    // `content.md` = 10 chars, all ASCII, adds 10 columns past `(`.
    expect(links?.[0]?.range.end.x).toBe(15);
  });

  it("x-range end minus start plus one equals path visual length", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("(abc.md)");
    expect(links).toHaveLength(1);
    // "abc.md" is 6 ASCII chars, each 1 column wide.
    expect(
      (links?.[0]?.range.end.x ?? 0) - (links?.[0]?.range.start.x ?? 0) + 1,
    ).toBe(6);
  });
});
