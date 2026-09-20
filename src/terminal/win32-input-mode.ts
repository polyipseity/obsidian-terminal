/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Adapted from xterm.js `Win32InputMode` for the xterm.js 6.x release line.
 * Diverges in the virtual key: upstream prefers the `code` (position) table,
 * which assumes US QWERTY; here `keyCode` wins because Chromium on Windows
 * reports the OS virtual key in it (Blink `keyboard_event.cc`). Diverges in
 * AltGr: upstream sets `RIGHT_ALT_PRESSED` only on the `AltRight` key's own
 * events; here the `AltGraph` modifier state sets it, with `LEFT_CTRL_PRESSED`,
 * on every key typed through AltGr, as Windows reports it. Diverges in astral
 * characters: upstream sends `Uc` 0; here each surrogate gets its own record.
 * Adds the predicates for the keys that stay unencoded, `isImeKeyEvent` and
 * `isWin32ClipboardChord`.
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

/** `VK_PROCESSKEY`: Chromium reports it while an IME owns the key. */
const VK_PROCESSKEY = 0xe5;

/** The keys of the clipboard chords, see `isWin32ClipboardChord`. */
const VK_INSERT = 0x2d,
  VK_C = 0x43,
  VK_V = 0x56;

interface Win32KeyboardEvent {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly getModifierState?: (key: string) => boolean;
  readonly key: string;
  readonly keyCode: number;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly type: string;
}

/** Encode browser keyboard events as Win32 `KEY_EVENT_RECORD` CSI sequences. */
export class Win32InputMode {
  readonly #codeToVirtualKey: Readonly<Record<string, number | undefined>> = {
    KeyA: 0x41,
    KeyB: 0x42,
    KeyC: VK_C,
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
    KeyV: VK_V,
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
    Insert: VK_INSERT,
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

  /** Ctrl mappings outside the ASCII `@` through `~` range. */
  readonly #keyToCtrlCharacter: Readonly<Record<string, number | undefined>> = {
    " ": 0x00,
    "/": 0x1f,
    "?": 0x7f,
    "2": 0x00,
    "3": 0x1b,
    "4": 0x1c,
    "5": 0x1d,
    "6": 0x1e,
    "7": 0x1f,
    "8": 0x7f,
  };

  /**
   * Format: `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`. A non-zero `virtualKey`
   * replaces the event's own; a composed keypress carries its deferred
   * keydown's. An astral character takes two records, one per surrogate, as
   * Windows delivers it.
   */
  public encode(
    event: Win32KeyboardEvent,
    isKeyDown: boolean,
    virtualKey = 0,
  ): string {
    const virtualKey2 = virtualKey || this.#getVirtualKeyCode(event),
      scanCode = this.#codeToScanCode[event.code] ?? 0,
      keyDown = isKeyDown ? 1 : 0,
      controlKeyState = this.#getControlKeyState(event);

    return this.#getUnicodeCharacters(event)
      .map(
        (unicodeCharacter) =>
          "\x1b[" +
          [
            virtualKey2,
            scanCode,
            unicodeCharacter,
            keyDown,
            controlKeyState,
            1,
          ].join(";") +
          "_",
      )
      .join("");
  }

  /** The virtual key `encode` would use for the event. */
  public virtualKey(event: Win32KeyboardEvent): number {
    return this.#getVirtualKeyCode(event);
  }

  /**
   * Whether an IME owns the key, so it must not be encoded. The keydown that
   * starts a composition has `isComposing` false; only its `keyCode` or `key`
   * tells. A keypress's `keyCode` is its character (229 is `å`).
   */
  public isImeKeyEvent(event: Win32KeyboardEvent): boolean {
    return (
      event.type !== "keypress" &&
      (event.keyCode === VK_PROCESSKEY || event.key === "Process")
    );
  }

  /**
   * On keydown and keyup, `keyCode` is the virtual key the OS reported, so it
   * follows the layout: Ctrl+Z on QWERTZ is `VK_Z` at the `KeyY` position,
   * and numpad End without NumLock is `VK_END`. The position table covers a
   * missing value. A keypress's `keyCode` is its character.
   */
  #getVirtualKeyCode(event: Win32KeyboardEvent): number {
    const { keyCode } = event;
    if (event.type !== "keypress" && keyCode > 0) {
      return keyCode;
    }
    return this.#codeToVirtualKey[event.code] ?? 0;
  }

  /** One UTF-16 code unit per record. */
  #getUnicodeCharacters(event: Win32KeyboardEvent): readonly number[] {
    const { key } = event;
    if (key.length === 2 && (key.codePointAt(0) ?? 0) > 0xffff) {
      return [key.charCodeAt(0), key.charCodeAt(1)];
    }
    return [this.#getUnicodeCharacter(event)];
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
      // Match Windows' Ctrl conversion: letters and punctuation use the
      // low five ASCII bits (for example, Ctrl+[ becomes ESC).
      if (codePoint >= 0x40 && codePoint <= 0x7e) {
        return codePoint & 0x1f;
      }
      const ctrlCharacter = this.#keyToCtrlCharacter[event.key];
      if (ctrlCharacter !== undefined) {
        return ctrlCharacter;
      }
    }
    return codePoint;
  }

  #getControlKeyState(event: Win32KeyboardEvent): number {
    // Windows reports AltGr as right Alt with left Ctrl; the browser reports
    // it as Ctrl+Alt with the `AltGraph` modifier.
    const altGraph = event.getModifierState?.("AltGraph") ?? false;
    let state = 0;

    if (event.shiftKey) {
      state |= Win32ControlKeyState.SHIFT_PRESSED;
    }
    if (event.ctrlKey || altGraph) {
      state |=
        event.code === "ControlRight"
          ? Win32ControlKeyState.RIGHT_CTRL_PRESSED
          : Win32ControlKeyState.LEFT_CTRL_PRESSED;
    }
    if (event.altKey || altGraph) {
      state |=
        event.code === "AltRight" || altGraph
          ? Win32ControlKeyState.RIGHT_ALT_PRESSED
          : Win32ControlKeyState.LEFT_ALT_PRESSED;
    }
    if (this.#enhancedKeyCodes.has(event.code)) {
      state |= Win32ControlKeyState.ENHANCED_KEY;
    }
    return state;
  }
}

/**
 * The clipboard chords xterm.js leaves to the browser by having no key for
 * them (`Keyboard.ts`): Shift+Insert and Ctrl+Shift+V paste, Ctrl+Insert and
 * Ctrl+Shift+C copy. The browser binds them by virtual key.
 */
export function isWin32ClipboardChord(
  event: Win32KeyboardEvent,
  virtualKey: number,
): boolean {
  const { ctrlKey, shiftKey } = event;
  if (event.altKey || event.metaKey) {
    return false;
  }
  switch (virtualKey) {
    case VK_INSERT:
      return ctrlKey !== shiftKey;
    case VK_C:
    case VK_V:
      return ctrlKey && shiftKey;
    default:
      return false;
  }
}
