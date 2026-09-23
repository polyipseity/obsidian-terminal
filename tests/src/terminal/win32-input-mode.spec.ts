import { describe, expect, it } from "vitest";
import {
  Win32ControlKeyState,
  Win32InputMode,
  isWin32ClipboardChord,
} from "../../../src/terminal/win32-input-mode.js";

/**
 * `keyCode` and `getModifierState` are not settable through the init
 * dictionary, so they are defined explicitly.
 */
function keyboardEvent(
  overrides: Readonly<Partial<KeyboardEvent>>,
  keyCode?: number,
): KeyboardEvent {
  const event = new KeyboardEvent(overrides.type ?? "keydown", overrides),
    { getModifierState } = overrides;
  if (keyCode !== void 0) {
    Object.defineProperty(event, "keyCode", { value: keyCode });
  }
  if (getModifierState) {
    Object.defineProperty(event, "getModifierState", {
      value: getModifierState,
    });
  }
  return event;
}

describe("Win32InputMode", () => {
  const mode = new Win32InputMode();

  it("encodes keydown and keyup with the six Win32 fields", () => {
    const event = keyboardEvent({ code: "KeyA", key: "a" });

    expect(mode.encode(event, true)).toBe("\x1b[65;30;97;1;0;1_");
    expect(mode.encode(event, false)).toBe("\x1b[65;30;97;0;0;1_");
  });

  it("encodes Backspace as VK 8, scan code 14, and Unicode 8", () => {
    const event = keyboardEvent({ code: "Backspace", key: "Backspace" });

    expect(mode.encode(event, true)).toBe("\x1b[8;14;8;1;0;1_");
  });

  it("encodes Ctrl+Backspace with Unicode DEL and left Ctrl state", () => {
    const event = keyboardEvent({
      code: "Backspace",
      ctrlKey: true,
      key: "Backspace",
    });

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [8, 14, 127, 1, Win32ControlKeyState.LEFT_CTRL_PRESSED, 1].join(";") +
        "_",
    );
  });

  it("encodes Enter, Tab, and Escape with their control characters", () => {
    expect(
      mode.encode(keyboardEvent({ code: "Enter", key: "Enter" }), true),
    ).toBe("\x1b[13;28;13;1;0;1_");
    expect(mode.encode(keyboardEvent({ code: "Tab", key: "Tab" }), true)).toBe(
      "\x1b[9;15;9;1;0;1_",
    );
    expect(
      mode.encode(keyboardEvent({ code: "Escape", key: "Escape" }), true),
    ).toBe("\x1b[27;1;27;1;0;1_");
  });

  it("maps Ctrl+letter to its ASCII control character", () => {
    const event = keyboardEvent({ code: "KeyC", ctrlKey: true, key: "c" });

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [67, 46, 3, 1, Win32ControlKeyState.LEFT_CTRL_PRESSED, 1].join(";") +
        "_",
    );
  });

  it.each([
    ["[", 27],
    ["\\", 28],
    ["]", 29],
    ["^", 30],
    ["_", 31],
    ["@", 0],
    [" ", 0],
    ["/", 31],
    ["?", 127],
    ["2", 0],
    ["3", 27],
    ["4", 28],
    ["5", 29],
    ["6", 30],
    ["7", 31],
    ["8", 127],
  ])("maps Ctrl+%s to control character %i", (key, expected) => {
    const event = keyboardEvent({ key, ctrlKey: true });
    for (const keyDown of [true, false]) {
      expect(mode.encode(event, keyDown).split(";")[2]).toBe(String(expected));
    }
    const altGr = keyboardEvent({ key, ctrlKey: true, altKey: true });
    expect(mode.encode(altGr, true).split(";")[2]).toBe(
      String(key.charCodeAt(0)),
    );
  });

  it("marks navigation and right-side modifier keys as enhanced", () => {
    const arrow = keyboardEvent({ code: "ArrowLeft", key: "ArrowLeft" });
    const rightControl = keyboardEvent({
      code: "ControlRight",
      ctrlKey: true,
      key: "Control",
    });

    expect(mode.encode(arrow, true)).toBe(
      "\x1b[" +
        [37, 75, 0, 1, Win32ControlKeyState.ENHANCED_KEY, 1].join(";") +
        "_",
    );
    expect(mode.encode(rightControl, true)).toBe(
      "\x1b[" +
        [
          17,
          29,
          0,
          1,
          Win32ControlKeyState.RIGHT_CTRL_PRESSED |
            Win32ControlKeyState.ENHANCED_KEY,
          1,
        ].join(";") +
        "_",
    );
  });

  it("encodes an unmapped key by its keyCode alone", () => {
    const event = keyboardEvent({ key: "Unidentified" }, 255);

    expect(mode.encode(event, true)).toBe("\x1b[255;0;0;1;0;1_");
  });

  // The virtual key follows the layout (`keyCode`); the scan code follows the
  // physical position (`code`). On a non-US layout the two disagree, exactly
  // as Windows reports them.

  it("takes the virtual key from keyCode, so QWERTZ Ctrl+Z is VK_Z", () => {
    const event = keyboardEvent({ code: "KeyY", ctrlKey: true, key: "z" }, 90);

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [90, 21, 26, 1, Win32ControlKeyState.LEFT_CTRL_PRESSED, 1].join(";") +
        "_",
    );
  });

  it("encodes numpad End without NumLock as VK_END on the numpad scan code", () => {
    const event = keyboardEvent({ code: "Numpad1", key: "End" }, 35);

    // Not an enhanced key, unlike the main-block End.
    expect(mode.encode(event, true)).toBe("\x1b[35;79;0;1;0;1_");
  });

  it("keeps a layout's OEM key identity", () => {
    const event = keyboardEvent({ code: "Minus", key: "ß" }, 219);

    expect(mode.encode(event, true)).toBe("\x1b[219;12;223;1;0;1_");
  });

  it("falls back to the position table for a missing keyCode", () => {
    expect(
      mode.encode(keyboardEvent({ code: "KeyA", key: "a" }, 0), true),
    ).toBe("\x1b[65;30;97;1;0;1_");
  });

  it("reports the key events an IME owns", () => {
    // The keydown that starts a composition: `isComposing` is still false.
    expect(
      mode.isImeKeyEvent(keyboardEvent({ code: "KeyA", key: "Process" }, 229)),
    ).toBe(true);
    expect(
      mode.isImeKeyEvent(keyboardEvent({ code: "KeyA", key: "a" }, 229)),
    ).toBe(true);
    expect(
      mode.isImeKeyEvent(
        keyboardEvent({ code: "KeyA", key: "Process", type: "keyup" }, 0),
      ),
    ).toBe(true);
    expect(
      mode.isImeKeyEvent(keyboardEvent({ code: "KeyA", key: "a" }, 0)),
    ).toBe(false);
    // A keypress's `keyCode` 229 is the character `å`.
    expect(
      mode.isImeKeyEvent(
        keyboardEvent({ code: "KeyA", key: "å", type: "keypress" }, 229),
      ),
    ).toBe(false);
  });

  // Windows reports AltGr as right Alt with left Ctrl (0x09); the browser
  // reports Ctrl+Alt with the `AltGraph` modifier.

  it("encodes AltGr+0 on AZERTY as right Alt with left Ctrl", () => {
    const event = keyboardEvent(
      {
        altKey: true,
        code: "Digit0",
        ctrlKey: true,
        getModifierState: (key) => key === "AltGraph",
        key: "@",
      },
      48,
    );

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [
          48,
          11,
          64,
          1,
          Win32ControlKeyState.RIGHT_ALT_PRESSED |
            Win32ControlKeyState.LEFT_CTRL_PRESSED,
          1,
        ].join(";") +
        "_",
    );
  });

  it("keeps left Ctrl+Alt apart from AltGr", () => {
    const event = keyboardEvent(
      {
        altKey: true,
        code: "Digit0",
        ctrlKey: true,
        getModifierState: () => false,
        key: "0",
      },
      48,
    );

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [
          48,
          11,
          48,
          1,
          Win32ControlKeyState.LEFT_ALT_PRESSED |
            Win32ControlKeyState.LEFT_CTRL_PRESSED,
          1,
        ].join(";") +
        "_",
    );
  });

  it("sends an astral character as one record per surrogate", () => {
    const event = keyboardEvent({ code: "KeyA", key: "\u{1d400}" }, 65);

    expect(mode.encode(event, true)).toBe(
      "\x1b[65;30;55349;1;0;1_\x1b[65;30;56320;1;0;1_",
    );
    expect(mode.encode(event, false)).toBe(
      "\x1b[65;30;55349;0;0;1_\x1b[65;30;56320;0;0;1_",
    );
  });

  it("ignores a keypress's keyCode, which is its character", () => {
    const event = keyboardEvent(
      { code: "KeyE", key: "é", type: "keypress" },
      233,
    );

    expect(mode.encode(event, true)).toBe("\x1b[69;18;233;1;0;1_");
    expect(mode.virtualKey(event)).toBe(69);
  });

  it("uses an explicit virtual key and treats 0 as absent", () => {
    const event = keyboardEvent(
      { code: "KeyE", key: "é", type: "keypress" },
      233,
    );

    expect(mode.encode(event, true, 90)).toBe("\x1b[90;18;233;1;0;1_");
    expect(mode.encode(event, true, 0)).toBe("\x1b[69;18;233;1;0;1_");
  });
});

describe("isWin32ClipboardChord", () => {
  const VK_INSERT = 45,
    VK_C = 67,
    VK_V = 86;

  it.each([
    { chord: { shiftKey: true }, name: "Shift+Insert", virtualKey: VK_INSERT },
    { chord: { ctrlKey: true }, name: "Ctrl+Insert", virtualKey: VK_INSERT },
    {
      chord: { ctrlKey: true, shiftKey: true },
      name: "Ctrl+Shift+C",
      virtualKey: VK_C,
    },
    {
      chord: { ctrlKey: true, shiftKey: true },
      name: "Ctrl+Shift+V",
      virtualKey: VK_V,
    },
  ])("reports $name", ({ chord, virtualKey }) => {
    expect(isWin32ClipboardChord(keyboardEvent(chord), virtualKey)).toBe(true);
    expect(
      isWin32ClipboardChord(
        keyboardEvent({ ...chord, altKey: true }),
        virtualKey,
      ),
    ).toBe(false);
    expect(
      isWin32ClipboardChord(
        keyboardEvent({ ...chord, metaKey: true }),
        virtualKey,
      ),
    ).toBe(false);
  });

  it.each([
    { chord: {}, name: "Insert", virtualKey: VK_INSERT },
    {
      chord: { ctrlKey: true, shiftKey: true },
      name: "Ctrl+Shift+Insert",
      virtualKey: VK_INSERT,
    },
    { chord: {}, name: "V", virtualKey: VK_V },
    { chord: { ctrlKey: true }, name: "Ctrl+V", virtualKey: VK_V },
    { chord: { shiftKey: true }, name: "Shift+C", virtualKey: VK_C },
    {
      chord: { ctrlKey: true, shiftKey: true },
      name: "Ctrl+Shift+X",
      virtualKey: 88,
    },
  ])("does not report $name", ({ chord, virtualKey }) => {
    expect(isWin32ClipboardChord(keyboardEvent(chord), virtualKey)).toBe(false);
  });
});
