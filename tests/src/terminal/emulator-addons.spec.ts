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
 *   synchronized output blocks (xterm.js issue #5801 workaround)
 * - SynchronizedOutputScrollAddon: ED2 (\x1b[2J) suppression inside sync blocks
 *   to eliminate screen flicker (screen-clear flash before redrawn content)
 */
import type { IDisposable, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../../src/settings-data.js";
import {
  CustomKeyEventHandlerAddon,
  FollowThemeAddon,
  SynchronizedOutputScrollAddon,
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls scrollToBottom() after sync block when user was at bottom", () => {
    vi.useFakeTimers();
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
    vi.runAllTimers();
    expect(scrollToBottomSpy).toHaveBeenCalledOnce();
  });

  it("calls scrollToLine() with delta-adjusted position when user was scrolled up", () => {
    vi.useFakeTimers();
    // viewportY(5) < baseY(10) → scrolled up 5 lines from bottom page
    const mock = createSyncMockTerminal(5, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(mock.terminal);

    // Begin sync; simulate ED2 growing baseY by 20 during the block
    mock.triggerCsi("?", "h", [2026]);
    mock.setBuffer(30, 30); // after ED2 + redraw: baseY grew from 10 → 30
    mock.triggerCsi("?", "l", [2026]);

    vi.runAllTimers();
    // Expected: viewportY 5 + delta(20) = 25, clamped to baseY(30)
    expect(mock.scrollToLineSpy).toHaveBeenCalledWith(25);
    expect(mock.scrollToBottomSpy).not.toHaveBeenCalled();
  });

  it("clamps restored viewportY to [0, baseY]", () => {
    vi.useFakeTimers();
    // viewportY(3) < baseY(5) → scrolled up
    const mock = createSyncMockTerminal(3, 5);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(mock.terminal);

    mock.triggerCsi("?", "h", [2026]);
    // baseY shrinks (unlikely but defensive): 5 → 0
    mock.setBuffer(0, 0);
    mock.triggerCsi("?", "l", [2026]);

    vi.runAllTimers();
    // vY(3) + delta(-5) = -2 → clamped to 0
    expect(mock.scrollToLineSpy).toHaveBeenCalledWith(0);
  });

  it("only snapshots scroll state at the outermost sync block entry (nested blocks)", () => {
    vi.useFakeTimers();
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
    vi.runAllTimers();
    expect(mock.scrollToBottomSpy).not.toHaveBeenCalled();

    // Outer end (depth back to 0 — must restore now)
    mock.setBuffer(10, 10);
    mock.triggerCsi("?", "l", [2026]);
    vi.runAllTimers();
    // Original snapshot was atBottom=true (viewportY 10 >= baseY 10)
    expect(mock.scrollToBottomSpy).toHaveBeenCalledOnce();
  });

  it("ignores ?2026l without a preceding ?2026h", () => {
    vi.useFakeTimers();
    const { terminal, scrollToBottomSpy, scrollToLineSpy, triggerCsi } =
      createSyncMockTerminal(0, 0);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    // End without begin — must be a no-op
    triggerCsi("?", "l", [2026]);
    vi.runAllTimers();
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
    expect(scrollToLineSpy).not.toHaveBeenCalled();
  });

  it("does not interfere with unrelated CSI ?h/?l sequences", () => {
    vi.useFakeTimers();
    const { terminal, scrollToBottomSpy, scrollToLineSpy, triggerCsi } =
      createSyncMockTerminal(10, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    // ?1049h / ?1049l are alt-screen sequences — must be ignored
    triggerCsi("?", "h", [1049]);
    triggerCsi("?", "l", [1049]);
    vi.runAllTimers();
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

  // === ED2 suppression (flicker fix) ===

  it("suppresses ED2 (\\x1b[2J) inside a sync block — returns true", () => {
    const { terminal, triggerCsi } = createSyncMockTerminal(10, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    // Open a sync block; ED2 inside must be suppressed to prevent blank-screen flash.
    triggerCsi("?", "h", [2026]);
    const results = triggerCsi("", "J", [2]);
    expect(results).toEqual([true]);
  });

  it("does not suppress ED2 outside a sync block — returns false", () => {
    const { terminal, triggerCsi } = createSyncMockTerminal(10, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    // No sync block open — ED2 must pass through to xterm normally.
    const results = triggerCsi("", "J", [2]);
    expect(results).toEqual([false]);
  });

  it("does not suppress ED0, ED1, ED3 inside a sync block — returns false", () => {
    const { terminal, triggerCsi } = createSyncMockTerminal(10, 10);
    const addon = new SynchronizedOutputScrollAddon();
    addon.activate(terminal);

    triggerCsi("?", "h", [2026]);
    // Only ED2 (full clear) should be suppressed; other erase modes must pass through.
    expect(triggerCsi("", "J", [0])).toEqual([false]); // erase to end of screen
    expect(triggerCsi("", "J", [1])).toEqual([false]); // erase to beginning
    expect(triggerCsi("", "J", [3])).toEqual([false]); // erase scrollback
  });
});
