/**
 * Unit tests for `CustomKeyEventHandlerAddon` in `src/terminal/emulator-addons.ts`.
 *
 * Covers:
 * - Option+printable character passthrough (macOS xterm bug #2831 workaround)
 * - Option+non-character keys (arrows, function keys, Enter) now pass through
 *   to xterm when no key mapping matches — the old suppression was a bug
 * - Key mapping actions including the new "passthrough" action
 * - Shift+Enter ESC+CR injection via default key mapping (not hardcoded)
 * - Guard conditions (disposed, platform, setting, modifier combos)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CustomKeyEventHandlerAddon,
  FollowThemeAddon,
} from "../../../src/terminal/emulator-addons.js";
import type { Terminal } from "@xterm/xterm";
import type { Settings } from "../../../src/settings-data.js";

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
const SHIFT_ENTER_MAPPING: Settings.KeyMapping = {
  action: "sendEscapeSequence",
  actionArg: "\r",
  alt: false,
  ctrl: false,
  key: "Enter",
  meta: false,
  platform: undefined,
  shift: true,
};

describe("CustomKeyEventHandlerAddon", () => {
  let inputSpy: ReturnType<typeof vi.fn>;
  let handler: (event: KeyboardEvent) => boolean;

  /** Helper: activate addon with passthrough enabled and return handler. */
  function setup(
    isEnabled = true,
    getMappings: () => readonly Settings.KeyMapping[] = () => [],
    currentPlatform = "darwin",
  ) {
    const mock = createMockTerminal();
    inputSpy = mock.inputSpy;
    const addon = new CustomKeyEventHandlerAddon(
      getMappings,
      currentPlatform,
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
  // xterm normally when no key mapping covers them).

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

  // === Key mapping actions ===

  it("'ignore' action suppresses the event and sends nothing", () => {
    setup(false, () => [
      {
        key: "a",
        alt: false,
        ctrl: true,
        meta: false,
        shift: false,
        platform: undefined,
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
        platform: undefined,
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
        platform: undefined,
        action: "sendEscapeSequence",
        actionArg: "b",
      },
    ]);
    const result = handler(fakeKeyEvent({ key: "b", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1bb");
  });

  // === Shift+Enter (now provided via key mapping, not hardcoded) ===

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
    // With no keyMappings and passthrough disabled, Shift+Enter is not handled
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
