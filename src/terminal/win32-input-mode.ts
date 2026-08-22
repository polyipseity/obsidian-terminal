/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Adapted from xterm.js `Win32InputMode` for the xterm.js 6.x release line.
 * @see https://github.com/xtermjs/xterm.js/blob/master/src/common/input/Win32InputMode.ts
 * @see https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md
 */

export enum Win32ControlKeyState {
  RIGHT_ALT_PRESSED = 0b000000001,
  LEFT_ALT_PRESSED = 0b000000010,
  RIGHT_CTRL_PRESSED = 0b000000100,
  LEFT_CTRL_PRESSED = 0b000001000,
  SHIFT_PRESSED = 0b000010000,
  NUMLOCK_ON = 0b000100000,
  SCROLLLOCK_ON = 0b001000000,
  CAPSLOCK_ON = 0b010000000,
  ENHANCED_KEY = 0b100000000,
}

interface Win32KeyboardEvent {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly keyCode: number;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** Encode browser keyboard events as Win32 `KEY_EVENT_RECORD` CSI sequences. */
export class Win32InputMode {
  readonly #codeToVirtualKey: Readonly<Record<string, number | undefined>> = {
    KeyA: 0x41,
    KeyB: 0x42,
    KeyC: 0x43,
    KeyD: 0x44,
    KeyE: 0x45,
    KeyF: 0x46,
    KeyG: 0x47,
    KeyH: 0x48,
    KeyI: 0x49,
    KeyJ: 0x4a,
    KeyK: 0x4b,
    KeyL: 0x4c,
    KeyM: 0x4d,
    KeyN: 0x4e,
    KeyO: 0x4f,
    KeyP: 0x50,
    KeyQ: 0x51,
    KeyR: 0x52,
    KeyS: 0x53,
    KeyT: 0x54,
    KeyU: 0x55,
    KeyV: 0x56,
    KeyW: 0x57,
    KeyX: 0x58,
    KeyY: 0x59,
    KeyZ: 0x5a,
    Digit0: 0x30,
    Digit1: 0x31,
    Digit2: 0x32,
    Digit3: 0x33,
    Digit4: 0x34,
    Digit5: 0x35,
    Digit6: 0x36,
    Digit7: 0x37,
    Digit8: 0x38,
    Digit9: 0x39,
    F1: 0x70,
    F2: 0x71,
    F3: 0x72,
    F4: 0x73,
    F5: 0x74,
    F6: 0x75,
    F7: 0x76,
    F8: 0x77,
    F9: 0x78,
    F10: 0x79,
    F11: 0x7a,
    F12: 0x7b,
    F13: 0x7c,
    F14: 0x7d,
    F15: 0x7e,
    F16: 0x7f,
    F17: 0x80,
    F18: 0x81,
    F19: 0x82,
    F20: 0x83,
    F21: 0x84,
    F22: 0x85,
    F23: 0x86,
    F24: 0x87,
    Numpad0: 0x60,
    Numpad1: 0x61,
    Numpad2: 0x62,
    Numpad3: 0x63,
    Numpad4: 0x64,
    Numpad5: 0x65,
    Numpad6: 0x66,
    Numpad7: 0x67,
    Numpad8: 0x68,
    Numpad9: 0x69,
    NumpadMultiply: 0x6a,
    NumpadAdd: 0x6b,
    NumpadSeparator: 0x6c,
    NumpadSubtract: 0x6d,
    NumpadDecimal: 0x6e,
    NumpadDivide: 0x6f,
    NumpadEnter: 0x0d,
    NumLock: 0x90,
    ArrowUp: 0x26,
    ArrowDown: 0x28,
    ArrowLeft: 0x25,
    ArrowRight: 0x27,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Insert: 0x2d,
    Delete: 0x2e,
    ShiftLeft: 0x10,
    ShiftRight: 0x10,
    ControlLeft: 0x11,
    ControlRight: 0x11,
    AltLeft: 0x12,
    AltRight: 0x12,
    MetaLeft: 0x5b,
    MetaRight: 0x5c,
    CapsLock: 0x14,
    ScrollLock: 0x91,
    Escape: 0x1b,
    Enter: 0x0d,
    Tab: 0x09,
    Space: 0x20,
    Backspace: 0x08,
    Pause: 0x13,
    ContextMenu: 0x5d,
    PrintScreen: 0x2c,
    Semicolon: 0xba,
    Equal: 0xbb,
    Comma: 0xbc,
    Minus: 0xbd,
    Period: 0xbe,
    Slash: 0xbf,
    Backquote: 0xc0,
    BracketLeft: 0xdb,
    Backslash: 0xdc,
    BracketRight: 0xdd,
    Quote: 0xde,
    IntlBackslash: 0xe2,
  };

  readonly #codeToScanCode: Readonly<Record<string, number | undefined>> = {
    KeyQ: 0x10,
    KeyW: 0x11,
    KeyE: 0x12,
    KeyR: 0x13,
    KeyT: 0x14,
    KeyY: 0x15,
    KeyU: 0x16,
    KeyI: 0x17,
    KeyO: 0x18,
    KeyP: 0x19,
    KeyA: 0x1e,
    KeyS: 0x1f,
    KeyD: 0x20,
    KeyF: 0x21,
    KeyG: 0x22,
    KeyH: 0x23,
    KeyJ: 0x24,
    KeyK: 0x25,
    KeyL: 0x26,
    KeyZ: 0x2c,
    KeyX: 0x2d,
    KeyC: 0x2e,
    KeyV: 0x2f,
    KeyB: 0x30,
    KeyN: 0x31,
    KeyM: 0x32,
    Digit1: 0x02,
    Digit2: 0x03,
    Digit3: 0x04,
    Digit4: 0x05,
    Digit5: 0x06,
    Digit6: 0x07,
    Digit7: 0x08,
    Digit8: 0x09,
    Digit9: 0x0a,
    Digit0: 0x0b,
    F1: 0x3b,
    F2: 0x3c,
    F3: 0x3d,
    F4: 0x3e,
    F5: 0x3f,
    F6: 0x40,
    F7: 0x41,
    F8: 0x42,
    F9: 0x43,
    F10: 0x44,
    F11: 0x57,
    F12: 0x58,
    Numpad0: 0x52,
    Numpad1: 0x4f,
    Numpad2: 0x50,
    Numpad3: 0x51,
    Numpad4: 0x4b,
    Numpad5: 0x4c,
    Numpad6: 0x4d,
    Numpad7: 0x47,
    Numpad8: 0x48,
    Numpad9: 0x49,
    NumpadMultiply: 0x37,
    NumpadAdd: 0x4e,
    NumpadSubtract: 0x4a,
    NumpadDecimal: 0x53,
    NumpadDivide: 0x35,
    NumpadEnter: 0x1c,
    NumLock: 0x45,
    ArrowUp: 0x48,
    ArrowDown: 0x50,
    ArrowLeft: 0x4b,
    ArrowRight: 0x4d,
    Home: 0x47,
    End: 0x4f,
    PageUp: 0x49,
    PageDown: 0x51,
    Insert: 0x52,
    Delete: 0x53,
    ShiftLeft: 0x2a,
    ShiftRight: 0x36,
    ControlLeft: 0x1d,
    ControlRight: 0x1d,
    AltLeft: 0x38,
    AltRight: 0x38,
    CapsLock: 0x3a,
    ScrollLock: 0x46,
    Escape: 0x01,
    Enter: 0x1c,
    Tab: 0x0f,
    Space: 0x39,
    Backspace: 0x0e,
    Pause: 0x45,
    Semicolon: 0x27,
    Equal: 0x0d,
    Comma: 0x33,
    Minus: 0x0c,
    Period: 0x34,
    Slash: 0x35,
    Backquote: 0x29,
    BracketLeft: 0x1a,
    Backslash: 0x2b,
    BracketRight: 0x1b,
    Quote: 0x28,
  };

  readonly #enhancedKeyCodes: ReadonlySet<string> = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
    "NumpadEnter",
    "NumpadDivide",
    "ControlRight",
    "AltRight",
    "PrintScreen",
    "Pause",
    "ContextMenu",
    "MetaLeft",
    "MetaRight",
  ]);

  readonly #keyToControlCharacter: Readonly<
    Record<string, number | undefined>
  > = {
    Enter: 0x0d,
    Backspace: 0x08,
    Tab: 0x09,
    Escape: 0x1b,
  };

  /** Format: `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`. */
  public encode(event: Win32KeyboardEvent, isKeyDown: boolean): string {
    const virtualKey = this.#getVirtualKeyCode(event),
      scanCode = this.#codeToScanCode[event.code] ?? 0,
      unicodeCharacter = this.#getUnicodeCharacter(event),
      keyDown = isKeyDown ? 1 : 0,
      controlKeyState = this.#getControlKeyState(event);

    return (
      "\x1b[" +
      [
        virtualKey,
        scanCode,
        unicodeCharacter,
        keyDown,
        controlKeyState,
        1,
      ].join(";") +
      "_"
    );
  }

  #getVirtualKeyCode(event: Win32KeyboardEvent): number {
    const mapped = this.#codeToVirtualKey[event.code];
    if (mapped !== undefined) {
      return mapped;
    }
    return event.keyCode || 0;
  }

  #getUnicodeCharacter(event: Win32KeyboardEvent): number {
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      if (event.key === "Enter") {
        return 0x0a;
      }
      if (event.key === "Backspace") {
        return 0x7f;
      }
    }

    const controlCharacter = this.#keyToControlCharacter[event.key];
    if (controlCharacter !== undefined) {
      return controlCharacter;
    }

    if (event.key.length !== 1) {
      return 0;
    }

    const codePoint = event.key.codePointAt(0) ?? 0;
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      if (codePoint >= 0x41 && codePoint <= 0x5a) {
        return codePoint - 0x40;
      }
      if (codePoint >= 0x61 && codePoint <= 0x7a) {
        return codePoint - 0x60;
      }
    }
    return codePoint;
  }

  #getControlKeyState(event: Win32KeyboardEvent): number {
    let state = 0;

    if (event.shiftKey) {
      state |= Win32ControlKeyState.SHIFT_PRESSED;
    }
    if (event.ctrlKey) {
      state |=
        event.code === "ControlRight"
          ? Win32ControlKeyState.RIGHT_CTRL_PRESSED
          : Win32ControlKeyState.LEFT_CTRL_PRESSED;
    }
    if (event.altKey) {
      state |=
        event.code === "AltRight"
          ? Win32ControlKeyState.RIGHT_ALT_PRESSED
          : Win32ControlKeyState.LEFT_ALT_PRESSED;
    }
    if (this.#enhancedKeyCodes.has(event.code)) {
      state |= Win32ControlKeyState.ENHANCED_KEY;
    }
    return state;
  }
}
