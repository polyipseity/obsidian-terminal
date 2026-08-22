import { describe, expect, it } from "vitest";
import {
  Win32ControlKeyState,
  Win32InputMode,
} from "../../../src/terminal/win32-input-mode.js";

function keyboardEvent(
  overrides: Readonly<Partial<KeyboardEvent>>,
): KeyboardEvent {
  return new KeyboardEvent("keydown", overrides);
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

  it("falls back to keyCode for an unmapped browser code", () => {
    const event = keyboardEvent({ key: "Unidentified" });
    Object.defineProperty(event, "keyCode", { value: 255 });

    expect(mode.encode(event, true)).toBe("\x1b[255;0;0;1;0;1_");
  });
});
