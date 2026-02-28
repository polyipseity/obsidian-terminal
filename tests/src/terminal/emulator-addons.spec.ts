/**
 * Unit tests for `MacOSOptionKeyPassthroughAddon` in `src/terminal/emulator-addons.ts`.
 *
 * Covers:
 * - Option+printable character passthrough (PR #92 behavior)
 * - Option+Arrow/Backspace/Delete navigation sequences (new)
 * - Shift+Enter ESC+CR injection (consolidated from emulator.ts)
 * - Guard conditions (disposed, platform, setting, modifier combos)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MacOSOptionKeyPassthroughAddon } from "../../../src/terminal/emulator-addons.js";

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
  };

  return {
    terminal: terminal as unknown as import("@xterm/xterm").Terminal,
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
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("MacOSOptionKeyPassthroughAddon", () => {
  let inputSpy: ReturnType<typeof vi.fn>;
  let handler: (event: KeyboardEvent) => boolean;

  /** Helper: activate addon with passthrough enabled and return handler. */
  function setup(isEnabled = true) {
    const mock = createMockTerminal();
    inputSpy = mock.inputSpy;
    const addon = new MacOSOptionKeyPassthroughAddon(() => isEnabled);
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

  it("suppresses keypress to prevent duplicate character emission", () => {
    const result = handler(
      fakeKeyEvent({ key: "@", altKey: true, type: "keypress" }),
    );
    expect(result).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  // === Option+Arrow word navigation ===

  it("sends ESC+b for Option+Left (backward-word)", () => {
    const result = handler(fakeKeyEvent({ key: "ArrowLeft", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1bb");
  });

  it("sends ESC+f for Option+Right (forward-word)", () => {
    const result = handler(fakeKeyEvent({ key: "ArrowRight", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1bf");
  });

  // === Option+Backspace/Delete word deletion ===

  it("sends ESC+DEL for Option+Backspace (backward-kill-word)", () => {
    const result = handler(fakeKeyEvent({ key: "Backspace", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1b\x7f");
  });

  it("sends ESC+d for Option+Delete (forward-kill-word)", () => {
    const result = handler(fakeKeyEvent({ key: "Delete", altKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1bd");
  });

  // === Guard conditions ===

  it("passes through dead keys (incomplete composition)", () => {
    const result = handler(fakeKeyEvent({ key: "Dead", altKey: true }));
    // Dead keys have key.length > 1 and don't match any nav key,
    // so they fall through to the final return false
    expect(result).toBe(false);
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it("passes through Option+Enter (no interception)", () => {
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

  // === Shift+Enter (consolidated from emulator.ts) ===

  it("Shift+Enter sends ESC+CR (cross-platform, unconditional)", () => {
    // Works even when passthrough is disabled
    setup(false);
    const result = handler(fakeKeyEvent({ key: "Enter", shiftKey: true }));
    expect(result).toBe(false);
    expect(inputSpy).toHaveBeenCalledWith("\x1b\r");
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
