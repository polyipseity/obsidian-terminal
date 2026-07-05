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
 * - SynchronizedOutputScrollAddon: scroll position preservation across DEC 2026
 *   synchronized output blocks via queueMicrotask (xterm.js issue #5801 workaround)
 */
import type { ILink, ILinkProvider, IDisposable, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile, Vault, Workspace, WorkspaceLeaf } from "obsidian";
import type { PluginContext } from "@polyipseity/obsidian-plugin-library";
import type { Settings } from "../../../src/settings-data.js";
import {
  CustomKeyEventHandlerAddon,
  FollowThemeAddon,
  SynchronizedOutputScrollAddon,
  VaultFileLinksAddon,
} from "../../../src/terminal/emulator-addons.js";

/** Minimal mock Terminal with `input()` and `attachCustomKeyEventHandler()`. */
function createMockTerminal() {
  const inputSpy = vi.fn();
  let handler: ((event: KeyboardEvent) => boolean) | null = null;

  const terminal = {
    input: inputSpy,
    attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) {
      handler = fn;
    },
    element: document.createElement("div"),
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

  /** Helper: activate addon with passthrough enabled and return handler. */
  function setup(
    isEnabled = true,
    getMappings: () => readonly Settings.Keymapping[] = () => [],
    currentPlatform = "darwin",
  ) {
    const mock = createMockTerminal();
    inputSpy = mock.inputSpy;
    const addon = new CustomKeyEventHandlerAddon(
      currentPlatform,
      getMappings,
      () => isEnabled,
    );
    addon.activate(mock.terminal);
    handler = mock.getHandler();
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
        actionArg: "",
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
        actionArg: "",
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
    const { terminal } = createSyncMockTerminal(0, 0);

    // Capture return values by overriding triggerCsi to return them
    const returnVals: boolean[] = [];
    const origHandlers: Record<
      string,
      Array<(params: { [index: number]: number }) => boolean>
    > = {};
    const patchedTerminal = {
      ...terminal,
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
  const MOCK_FILE = { path: "test.md", name: "test.md" } as TFile;

  /**
   * Creates a VaultFileLinksAddon test bed.
   *
   * @param fileExists - Whether getFileByPath should return a TFile or null.
   */
  function createBed(fileExists = true): {
    provideLinks(lineText: string): ILink[] | undefined;
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
    expect(links).toBeUndefined();
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

  it("returns undefined for a line with no .md links", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("Just some plain text");
    expect(links).toBeUndefined();
  });

  it("returns undefined for empty line", () => {
    const { provideLinks } = createBed();
    const links = provideLinks("");
    expect(links).toBeUndefined();
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
    expect(links).toBeUndefined();
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

    let capturedProvider: ILinkProvider;
    const terminal = {
      registerLinkProvider: vi.fn((p: ILinkProvider) => {
        capturedProvider = p;
        return { dispose: vi.fn() };
      }),
      buffer: { active: { getLine: vi.fn() } },
      element: document.createElement("div"),
    } as unknown as Terminal;
    addon.activate(terminal);

    const line = { translateToString: vi.fn(() => "(test.md)") };
    terminal.buffer.active.getLine.mockReturnValue(line);
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
