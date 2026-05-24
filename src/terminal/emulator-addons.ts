import {
  Functions,
  type PluginContext,
  activeSelf,
  consumeEvent,
  deepFreeze,
  isNonNil,
  replaceAllRegex,
  revealPrivate,
} from "@polyipseity/obsidian-plugin-library";
import type { CanvasAddon } from "@xterm/addon-canvas";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ITerminalAddon, ITheme, Terminal } from "@xterm/xterm";
import { constant, isUndefined } from "lodash-es";
import { around } from "monkey-around";
import { noop } from "ts-essentials";
import type { Settings } from "../settings-data.js";

export class DisposerAddon extends Functions implements ITerminalAddon {
  public constructor(...args: readonly (() => void)[]) {
    super({ async: false, settled: true }, ...args);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public activate(_terminal: Terminal): void {
    // Noop
  }

  public dispose(): void {
    this.call();
  }
}

export class DragAndDropAddon implements ITerminalAddon {
  readonly #disposer = new Functions({ async: false, settled: true });

  public constructor(protected readonly element: HTMLElement) {}

  public activate(terminal: Terminal): void {
    const { element } = this,
      drop = (event: DragEvent): void => {
        terminal.paste(
          Array.from(event.dataTransfer?.files ?? [])
            .map((file) => file.path)
            .filter(isNonNil)
            .map((path) => path.replace(replaceAllRegex('"'), '\\"'))
            .map((path) => (path.includes(" ") ? `"${path}"` : path))
            .join(" "),
        );
        consumeEvent(event);
      },
      dragover = consumeEvent;
    this.#disposer.push(
      () => {
        element.removeEventListener("dragover", dragover);
      },
      () => {
        element.removeEventListener("drop", drop);
      },
    );
    element.addEventListener("drop", drop);
    element.addEventListener("dragover", dragover);
  }

  public dispose(): void {
    this.#disposer.call();
  }
}

export namespace FollowThemeAddon {
  export interface Options {
    /**
     * Whether the addon should apply changes.
     * Default: always true
     */
    readonly enabled?: () => boolean;

    /**
     * CSS custom properties to read. If a value is itself another var(), we
     * resolve it by delegating to the browser.
     */
    readonly bgVar?: string; // Default: --background-primary
    readonly fgVar?: string; // Default: --text-normal
    readonly accentVar?: string; // Default: --interactive-accent

    /**
     * Selection overlay alpha. 0..1
     * Default: 0.3
     */
    readonly selectionAlpha?: number;

    /**
     * Min contrast for cursor vs background. If accent cannot reach this,
     * fall back to the best of white/black/foreground.
     * Default: 3
     */
    readonly minCursorContrast?: number;
  }

  export interface RGBA {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
    readonly alpha: number;
  }
}
export class FollowThemeAddon implements ITerminalAddon {
  // -------------------------------------------------------------------------
  // Constants (removed magic numbers) — kept as private static class fields
  // -------------------------------------------------------------------------

  // CSS variable defaults
  static readonly #DEFAULT_BG_VAR = "--background-primary";
  static readonly #DEFAULT_FG_VAR = "--text-normal";
  static readonly #DEFAULT_ACCENT_VAR = "--interactive-accent";

  // Color constants
  static readonly #COLOR_ALPHA_OPAQUE = 1;
  static readonly #COLOR_ALPHA_MIN = 0;
  static readonly #COLOR_ALPHA_MAX = 1;

  static readonly #COLOR_BLACK: FollowThemeAddon.RGBA = {
    alpha: 1,
    blue: 0,
    green: 0,
    red: 0,
  };

  static readonly #COLOR_WHITE: FollowThemeAddon.RGBA = {
    alpha: 1,
    blue: 255,
    green: 255,
    red: 255,
  };

  // Selection alpha default
  static readonly #DEFAULT_SELECTION_ALPHA = 0.3;

  // Cursor contrast default (WCAG-ish practical threshold)
  static readonly #DEFAULT_MIN_CURSOR_CONTRAST = 3;

  // WCAG relative luminance constants (sRGB -> linear)
  static readonly #SRGB_THRESHOLD = 0.03928;
  static readonly #SRGB_DIVISOR = 12.92;
  static readonly #SRGB_A = 0.055;
  static readonly #SRGB_GAMMA = 2.4;
  static readonly #SRGB_FACTOR = 1.055;

  // WCAG luminance coefficients
  static readonly #LUM_COEFF_R = 0.2126;
  static readonly #LUM_COEFF_G = 0.7152;
  static readonly #LUM_COEFF_B = 0.0722;

  // WCAG contrast epsilon
  static readonly #CONTRAST_EPSILON = 0.05;

  // Number formatting for rgba alpha output
  static readonly #RGBA_ALPHA_DECIMALS = 3;

  // -------------------------------------------------------------------------
  // Instance fields
  // -------------------------------------------------------------------------

  readonly #disposer = new Functions({ async: false, settled: true });
  #lastThemeKey = "";
  #terminal: Terminal | null = null;

  public constructor(
    protected readonly context: PluginContext,
    protected readonly element: HTMLElement,
    protected readonly opts: FollowThemeAddon.Options = {},
  ) {}

  // -------------------------------------------------------------------------
  // Static methods (declared before private instance methods)
  // -------------------------------------------------------------------------

  /**
   * Resolves a CSS custom property to its final computed color string,
   * even if it is defined via nested var() indirections.
   */
  static #resolveCssColor(
    varName: string,
    attachTo: HTMLElement,
  ): string | null {
    const doc = attachTo.ownerDocument,
      view = doc.defaultView,
      computed = view?.getComputedStyle(attachTo),
      raw = computed?.getPropertyValue(varName) ?? "";

    // Explicitly check for non-empty string and no var() indirection
    if (raw !== "" && !raw.includes("var(")) {
      return raw;
    }

    // Robust path: let the browser resolve var(...) into a concrete color
    const probe = doc.createElement("div");
    probe.style.position = "absolute";
    probe.style.width = "0";
    probe.style.height = "0";
    probe.style.pointerEvents = "none";
    probe.style.visibility = "hidden";
    probe.style.backgroundColor = `var(${varName})`;
    const resolved = ((): string => {
      attachTo.appendChild(probe);
      try {
        return view?.getComputedStyle(probe).backgroundColor ?? "";
      } finally {
        probe.remove();
      }
    })();

    return resolved === "" ? null : resolved;
  }

  static #toCss(color: FollowThemeAddon.RGBA): string {
    const red = Math.round(color.red),
      green = Math.round(color.green),
      blue = Math.round(color.blue);

    if (color.alpha === FollowThemeAddon.#COLOR_ALPHA_OPAQUE) {
      return `rgb(${red}, ${green}, ${blue})`;
    }

    const alpha = Number(
      color.alpha.toFixed(FollowThemeAddon.#RGBA_ALPHA_DECIMALS),
    );

    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  /** WCAG relative luminance of sRGB color */
  static #lum(color: FollowThemeAddon.RGBA): number {
    const toLin = (chan: number): number => {
        const normalized = chan / 255;
        return normalized <= FollowThemeAddon.#SRGB_THRESHOLD
          ? normalized / FollowThemeAddon.#SRGB_DIVISOR
          : ((normalized + FollowThemeAddon.#SRGB_A) /
              FollowThemeAddon.#SRGB_FACTOR) **
              FollowThemeAddon.#SRGB_GAMMA;
      },
      redLin = toLin(color.red),
      greenLin = toLin(color.green),
      blueLin = toLin(color.blue);

    return (
      FollowThemeAddon.#LUM_COEFF_R * redLin +
      FollowThemeAddon.#LUM_COEFF_G * greenLin +
      FollowThemeAddon.#LUM_COEFF_B * blueLin
    );
  }

  /** Contrast ratio per WCAG between two colors */
  static #contrast(
    colorA: FollowThemeAddon.RGBA,
    colorB: FollowThemeAddon.RGBA,
  ): number {
    const lumA = FollowThemeAddon.#lum(colorA),
      lumB = FollowThemeAddon.#lum(colorB),
      [hi, lo] = lumA >= lumB ? [lumA, lumB] : [lumB, lumA];
    return (
      (hi + FollowThemeAddon.#CONTRAST_EPSILON) /
      (lo + FollowThemeAddon.#CONTRAST_EPSILON)
    );
  }

  /** Alpha blend: result = (1 - alpha) * base + alpha * top */
  static #mix(
    top: FollowThemeAddon.RGBA,
    base: FollowThemeAddon.RGBA,
    alpha: number,
  ): FollowThemeAddon.RGBA {
    const clamped = Math.min(
      FollowThemeAddon.#COLOR_ALPHA_MAX,
      Math.max(FollowThemeAddon.#COLOR_ALPHA_MIN, alpha),
    );

    return {
      alpha: FollowThemeAddon.#COLOR_ALPHA_OPAQUE, // Selection is opaque
      blue: base.blue * (1 - clamped) + top.blue * clamped,
      green: base.green * (1 - clamped) + top.green * clamped,
      red: base.red * (1 - clamped) + top.red * clamped,
    };
  }

  /** Pick color with highest contrast vs bg */
  static #bestOf(
    candidates: readonly FollowThemeAddon.RGBA[],
    bg: FollowThemeAddon.RGBA,
  ): FollowThemeAddon.RGBA {
    return candidates.reduce((best, current) => {
      const bestC = FollowThemeAddon.#contrast(best, bg),
        curC = FollowThemeAddon.#contrast(current, bg);
      return curC > bestC ? current : best;
    });
  }

  /** First candidate that meets min contrast, else null */
  static #bestMeetingContrast(
    candidates: FollowThemeAddon.RGBA[],
    bg: FollowThemeAddon.RGBA,
    min: number,
  ): FollowThemeAddon.RGBA | null {
    for (const color of candidates) {
      if (FollowThemeAddon.#contrast(color, bg) >= min) {
        return color;
      }
    }
    return null;
  }

  static #themeKey(theme: ITheme): string {
    return JSON.stringify({
      background: theme.background ?? null,
      cursor: theme.cursor ?? null,
      foreground: theme.foreground ?? null,
      selectionBackground: theme.selectionBackground ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Public members BEFORE private instance members (member-ordering)
  // -------------------------------------------------------------------------

  public activate(terminal: Terminal): void {
    this.#terminal = terminal;
    this.#update();

    const {
        app,
        app: { workspace },
      } = this.context,
      // Arrow closure captures the addon's `this` lexically so that
      // the patched function (where `this` is the app) can still reach
      // the private #update method without aliasing `this`.
      doUpdate = (): void => {
        this.#update();
      },
      // Keep in sync with app CSS/theme changes (no throttling)
      // Obsidian already takes care of system-level theme changes
      ref = workspace.on("css-change", doUpdate);
    this.#disposer.push(() => {
      workspace.offref(ref);
    });

    revealPrivate(
      this.context,
      [app],
      (app2) => {
        // Patch app.setAccentColor to invoke #update after it runs
        const unpatchSetAccent = around(app2, {
          setAccentColor(next) {
            return function patched(
              this: typeof app,
              ...args: Parameters<typeof next>
            ): ReturnType<typeof next> {
              next.apply(this, args);
              doUpdate();
            };
          },
        });
        this.#disposer.push(unpatchSetAccent);
      },
      noop,
    );
  }

  public refresh(force = false): void {
    if (force) {
      this.#lastThemeKey = "";
    }
    this.#update();
  }

  public dispose(): void {
    this.#disposer.call();
    this.#terminal = null;
  }

  // -------------------------------------------------------------------------
  // Private instance methods (after public members)
  // -------------------------------------------------------------------------

  #update(): void {
    if (this.#terminal === null) {
      return;
    }

    // When provided, only apply if enabled() returns true
    if (typeof this.opts.enabled === "function" && !this.opts.enabled()) {
      return;
    }

    const next = this.#computeTheme();
    if (next === null) {
      return;
    }

    // No-op if unchanged
    const key = FollowThemeAddon.#themeKey(next);
    if (key === this.#lastThemeKey) {
      return;
    }
    this.#lastThemeKey = key;

    // Ensure a new object so the terminal notices the change
    this.#terminal.options.theme = {
      ...(this.#terminal.options.theme ?? {}),
      background: next.background,
      cursor: next.cursor,
      foreground: next.foreground,
      selectionBackground: next.selectionBackground,
    };
  }

  /**
   * Derive an xterm theme from host CSS variables. Returns `null` if
   * nothing useful is computed.
   */
  #computeTheme(): {
    readonly background: string;
    readonly cursor: string;
    readonly foreground: string;
    readonly selectionBackground: string;
  } | null {
    const doc = this.element.ownerDocument,
      { defaultView: view, body } = doc;

    if (view === null) {
      return null;
    }

    const bgVar = this.opts.bgVar ?? FollowThemeAddon.#DEFAULT_BG_VAR,
      fgVar = this.opts.fgVar ?? FollowThemeAddon.#DEFAULT_FG_VAR,
      accentVar = this.opts.accentVar ?? FollowThemeAddon.#DEFAULT_ACCENT_VAR,
      // Resolve CSS variables to final, computed css color strings
      bgStr = FollowThemeAddon.#resolveCssColor(bgVar, body)?.trim() ?? "",
      fgVarStr = FollowThemeAddon.#resolveCssColor(fgVar, body)?.trim() ?? "",
      accentStr =
        FollowThemeAddon.#resolveCssColor(accentVar, body)?.trim() ?? "",
      computedBodyColor = view.getComputedStyle(body).color,
      bg = this.#toRGBA(bgStr);
    if (bg === null) {
      // Cannot theme without background
      return null;
    }

    const explicitFg =
        this.#toRGBA(fgVarStr) ?? this.#toRGBA(computedBodyColor),
      autoFg = FollowThemeAddon.#bestOf(
        [FollowThemeAddon.#COLOR_BLACK, FollowThemeAddon.#COLOR_WHITE],
        bg,
      ),
      fg = explicitFg ?? autoFg,
      // Cursor: try accent first but ensure minimum contrast
      minCursorContrast =
        this.opts.minCursorContrast ??
        FollowThemeAddon.#DEFAULT_MIN_CURSOR_CONTRAST,
      cursorCandidates = [
        this.#toRGBA(accentStr),
        fg,
        FollowThemeAddon.#COLOR_BLACK,
        FollowThemeAddon.#COLOR_WHITE,
      ].filter(isNonNil),
      cursor =
        FollowThemeAddon.#bestMeetingContrast(
          cursorCandidates,
          bg,
          minCursorContrast,
        ) ?? FollowThemeAddon.#bestOf(cursorCandidates, bg),
      // Selection: overlay high-contrast color over background
      alpha = Math.min(
        1,
        Math.max(
          0,
          this.opts.selectionAlpha ?? FollowThemeAddon.#DEFAULT_SELECTION_ALPHA,
        ),
      ),
      overlayBase = FollowThemeAddon.#bestOf(
        [FollowThemeAddon.#COLOR_BLACK, FollowThemeAddon.#COLOR_WHITE],
        bg,
      ),
      selection = FollowThemeAddon.#mix(overlayBase, bg, alpha);

    return {
      background: FollowThemeAddon.#toCss(bg),
      cursor: FollowThemeAddon.#toCss(cursor),
      foreground: FollowThemeAddon.#toCss(fg),
      selectionBackground: FollowThemeAddon.#toCss(selection),
    };
  }

  // --- Color utilities (WCAG aware) ----------------------------------------

  /** Parse any CSS color the browser understands into RGBA, or null */
  #toRGBA(input: string | null | undefined): FollowThemeAddon.RGBA | null {
    const doc = this.element.ownerDocument,
      view = doc.defaultView;
    if (!view) {
      return null;
    }

    const span = doc.createElement("span");
    span.style.color = "";
    span.style.color = input ?? "";

    if (span.style.color === "") {
      return null;
    }

    const colorStr = ((): string => {
        doc.body.appendChild(span);
        try {
          return view.getComputedStyle(span).color;
        } finally {
          span.remove();
        }
      })(),
      // Extract numeric channels with named groups
      RGBA_REGEX =
        /rgba?\s*\(\s*(?<red>\d+(?:\.\d+)?)\s*,\s*(?<green>\d+(?:\.\d+)?)\s*,\s*(?<blue>\d+(?:\.\d+)?)\s*(?:,\s*(?<alpha>\d+(?:\.\d+)?)\s*)?\)/iu,
      match = RGBA_REGEX.exec(colorStr);

    if (!match?.groups) {
      return null;
    }

    const red = Number(match.groups["red"]),
      green = Number(match.groups["green"]),
      blue = Number(match.groups["blue"]),
      hasAlpha = !isUndefined(match.groups["alpha"]),
      alpha = hasAlpha
        ? Number(match.groups["alpha"])
        : FollowThemeAddon.#COLOR_ALPHA_OPAQUE;

    if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
      return null;
    }
    return { alpha, blue, green, red };
  }
}

export class RendererAddon implements ITerminalAddon {
  public renderer: CanvasAddon | WebglAddon | null = null;
  #terminal: Terminal | null = null;

  public constructor(
    protected readonly canvasSupplier: () => CanvasAddon,
    protected readonly webglSupplier: () => WebglAddon,
  ) {}

  public use(renderer: RendererAddon.RendererOption): void {
    const term = this.#terminal;
    if (!term) {
      return;
    }
    const { element } = term;
    this.renderer?.dispose();
    switch (renderer) {
      case "dom":
        this.renderer = null;
        break;
      case "canvas":
        try {
          const renderer0 = this.canvasSupplier();
          term.loadAddon((this.renderer = renderer0));
          break;
        } catch (error) {
          activeSelf(element).console.warn(error);
          this.use("dom");
        }
        break;
      case "webgl": {
        try {
          const renderer0 = this.webglSupplier(),
            contextLoss = renderer0.onContextLoss(() => {
              try {
                this.use("webgl");
              } finally {
                contextLoss.dispose();
              }
            });
          term.loadAddon((this.renderer = renderer0));
        } catch (error) {
          activeSelf(element).console.warn(error);
          this.use("canvas");
        }
        break;
      }
      // No default
    }
  }

  public activate(terminal: Terminal): void {
    this.#terminal = terminal;
  }

  public dispose(): void {
    this.renderer?.dispose();
    this.#terminal = null;
  }
}
export namespace RendererAddon {
  export const RENDERER_OPTIONS = deepFreeze(["dom", "canvas", "webgl"]);
  export type RendererOption = (typeof RENDERER_OPTIONS)[number];
}

export class RightClickActionAddon implements ITerminalAddon {
  readonly #disposer = new Functions({ async: false, settled: true });

  public constructor(
    protected readonly action: () => RightClickActionAddon.Action = constant(
      "default",
    ),
  ) {}

  public activate(terminal: Terminal): void {
    const { element } = terminal;
    if (!element) {
      throw new Error();
    }
    const contextMenuListener = (ev: MouseEvent): void => {
      const action = this.action();
      if (action === "default") {
        return;
      }
      (async (): Promise<void> => {
        try {
          switch (action) {
            case "nothing":
              // How to send right click to the terminal?
              break;
            // @ts-expect-error: fallthrough
            case "copyPaste":
              if (terminal.hasSelection()) {
                await activeSelf(element).navigator.clipboard.writeText(
                  terminal.getSelection(),
                );
                terminal.clearSelection();
                break;
              }
            // eslint-disable-next-line no-fallthrough
            case "paste":
              terminal.paste(
                await activeSelf(element).navigator.clipboard.readText(),
              );
              break;
          }
        } catch (error) {
          activeSelf(element).console.error(error);
        }
      })();
      consumeEvent(ev);
    };
    this.#disposer.push(() => {
      element.removeEventListener("contextmenu", contextMenuListener);
    });
    element.addEventListener("contextmenu", contextMenuListener);
  }

  public dispose(): void {
    this.#disposer.call();
  }
}
export namespace RightClickActionAddon {
  export const ACTIONS = deepFreeze([
    "copyPaste",
    "default",
    "nothing",
    "paste",
  ]);
  export type Action = (typeof ACTIONS)[number];
}

/**
 * Unified custom key event handler addon that consolidates all key interception.
 *
 * The pipeline (in priority order):
 *
 * 1. **IME guard** — events fired during IME composition are passed through
 *    unchanged so the input method can operate unimpeded.
 *
 * 2. **Keymappings** — the user-defined (and built-in default) ordered list
 *    from `Settings.keymappings` is checked; the first match wins:
 *    - `"ignore"` — suppress the event, send nothing.
 *    - `"passthrough"` — yield to xterm.js as if no mapping matched; useful
 *      for explicitly opting out of a default mapping for a specific combo.
 *    - `"sendEscapeSequence"` / `"sendHexCode"` / `"sendText"` — fire the
 *      configured output and suppress the event.
 *    Each mapping can be restricted to a specific platform via its `platform`
 *    field; `undefined` means all platforms.
 *
 * 3. **macOS Option key passthrough** (enabled by `isPassthroughEnabled`):
 *    xterm.js issue #2831 — when `macOptionIsMeta` is `false`, xterm still
 *    fires ESC sequences for single-character Option+key events on macOS.
 *    When passthrough is enabled this stage intercepts those events, re-emits
 *    the browser-composed character (e.g., Option+2 → `@` on Finnish
 *    keyboards) via `terminal.input()`, and returns `false` to prevent xterm
 *    from also sending an ESC sequence.
 *    Internal rules of this stage (not user-configurable because they are
 *    correctness rules of the workaround, not preferences):
 *    - Option key alone → suppressed (prevents a stray bare ESC).
 *    - Option + single-character key → re-emit composed char, suppress event.
 *    - All other Option+key (Enter, function keys, arrows not covered by a
 *      mapping, etc.) → passed through to xterm unchanged.
 */
export class CustomKeyEventHandlerAddon implements ITerminalAddon {
  #terminal: Terminal | null = null;

  public constructor(
    protected readonly currentPlatform: string,
    protected readonly getKeymappings: () => readonly Settings.Keymapping[],
    protected readonly isPassthroughEnabled: () => boolean,
  ) {}

  public activate(terminal: Terminal): void {
    this.#terminal = terminal;
    terminal.attachCustomKeyEventHandler((event) => this.#handleEvent(event));
  }

  public dispose(): void {
    this.#terminal = null;
  }

  #handleEvent(event: KeyboardEvent): boolean {
    const terminal = this.#terminal;

    // Guard: addon uninitialized or disposed
    if (!terminal) {
      return true;
    }

    // Block during IME composition so the input method operates unimpeded.
    if (event.isComposing) {
      return true;
    }

    // --- Stage 1: keymappings ---
    // Walk the ordered list; first match wins.
    for (const mapping of this.getKeymappings()) {
      if (this.#matches(event, mapping)) {
        if (event.type === "keydown") {
          return this.#fire(terminal, mapping);
        }
        // For keyup: only suppress if the action is not passthrough.
        // Passthrough should let both keydown and keyup reach xterm.
        if (mapping.action === "passthrough") {
          return true;
        }
        // Suppress keyup for all other actions so xterm never sees this event.
        return false;
      }
    }

    // --- Stage 2: macOS Option key passthrough ---
    // Workaround for xterm.js issue #2831: even with macOptionIsMeta: false,
    // xterm fires ESC sequences for single-character Option+key events on macOS.
    // When passthrough is enabled we intercept those events, re-emit the
    // browser-composed character, and block xterm from processing them.

    // Only active when explicitly enabled on macOS.
    if (this.currentPlatform !== "darwin" || !this.isPassthroughEnabled()) {
      return true;
    }

    // Only relevant for Option+key. Events that also carry Cmd or Ctrl are not
    // affected by the Option-composition bug and should reach xterm normally.
    if (!event.altKey || event.metaKey || event.ctrlKey) {
      return true;
    }

    // Option key alone: suppress to prevent a stray bare ESC sequence that
    // some xterm builds fire for the modifier press/release itself.
    if (event.key === "Alt") {
      return false;
    }

    // Single-character keys (e.g., Option+2 → '@' on Finnish keyboard):
    // re-emit the browser-composed character and suppress the original event.
    // Both keydown and keyup are suppressed to avoid duplicate output.
    if (event.key.length === 1) {
      if (event.type === "keydown") {
        terminal.input(event.key);
      }
      return false;
    }

    // All other Option+key events (Enter, function keys, arrows not matched by
    // a keymapping, etc.): pass through to xterm unchanged.
    // These multi-character key names are not subject to the #2831 composition
    // bug, so xterm can handle them correctly without interception.
    return true;
  }

  #matches(event: KeyboardEvent, mapping: Settings.Keymapping): boolean {
    // Skip mappings that don't match the current platform
    if (
      mapping.platform !== null &&
      mapping.platform !== this.currentPlatform
    ) {
      return false;
    }
    return (
      event.key === mapping.key &&
      event.ctrlKey === mapping.ctrl &&
      event.altKey === mapping.alt &&
      event.metaKey === mapping.meta &&
      event.shiftKey === mapping.shift
    );
  }

  /**
   * Execute the action configured for a matched mapping. Returns `true` if
   * the event should be passed through to xterm after firing the action, or
   * `false` if the event should be suppressed.
   */
  #fire(terminal: Terminal, mapping: Settings.Keymapping): boolean {
    switch (mapping.action) {
      case "ignore":
        // Suppress the event, send nothing.
        break;
      case "passthrough":
        // Yield to xterm.js as if no mapping matched.
        return true;
      case "scrollLines": {
        // actionArg is a number; scroll that many lines (negative = up).
        terminal.scrollLines(mapping.actionArg);
        break;
      }
      case "scrollPages": {
        // actionArg is a number; scroll that many pages (negative = up).
        terminal.scrollPages(mapping.actionArg);
        break;
      }
      case "scrollToBottom":
        terminal.scrollToBottom();
        break;
      case "scrollToTop":
        terminal.scrollToTop();
        break;
      case "sendEscapeSequence":
        // Send ESC (\x1b) followed by actionArg.
        terminal.input("\x1b" + mapping.actionArg);
        break;
      case "sendHexCode": {
        // actionArg is space-separated hex bytes, e.g. "01 0d".
        const chars = mapping.actionArg
          .trim()
          .split(/\s+/)
          .map((token) => parseInt(token, 16))
          .filter((n) => !isNaN(n))
          .map((n) => String.fromCharCode(n))
          .join("");
        if (chars) {
          terminal.input(chars);
        }
        break;
      }
      case "sendText": {
        // actionArg is sent as-is; escape sequences \\n, \\t, \\e, \\a are
        // interpreted as their corresponding control characters.
        const text = mapping.actionArg
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\e/g, "\x1b")
          .replace(/\\a/g, "\x07");
        terminal.input(text);
        break;
      }
      // No default
    }
    return false;
  }
}

/**
 * Addon that scrolls to bottom when alt-screen mode exits.
 *
 * This ensures that after full-screen TUIs (e.g., Claude Code, vim, less)
 * close and exit alt-screen mode, the normal buffer is displayed at the bottom
 * of the viewport rather than at a possibly stale scroll position.
 */
export class AltScreenExitAddon implements ITerminalAddon {
  readonly #disposer = new Functions({ async: false, settled: true });

  public activate(terminal: Terminal): void {
    // Register a CSI handler for "?1049l" (alt-screen exit sequence).
    // When this sequence is received, schedule a scrollToBottom() via setTimeout(0)
    // to defer the scroll until after xterm has finished processing the buffer switch.
    const handler = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        if (params[0] === 1049) {
          setTimeout(() => {
            terminal.scrollToBottom();
          }, 0);
        }
        // Return false so xterm still processes the sequence normally.
        return false;
      },
    );
    this.#disposer.push(() => {
      handler.dispose();
    });
  }

  public dispose(): void {
    this.#disposer.call();
  }
}

/**
 * Addon that preserves the scroll position across DEC 2026 synchronized output
 * blocks (begin: `\x1b[?2026h`, end: `\x1b[?2026l`), and suppresses ED2
 * (`\x1b[2J`) inside those blocks to eliminate screen flicker.
 *
 * AI coding agents (e.g., pi, Claude Code) use synchronized output with ED2
 * (`\x1b[2J`) inside each block to atomically redraw their TUI. This causes
 * two visible artefacts in xterm.js 6.x:
 *
 * 1. **Scroll yank:** `\x1b[2J` resets `viewportY`, yanking the viewport to
 *    the bottom on every redraw frame.
 * 2. **Screen flicker:** the canvas paints the cleared (blank) buffer before
 *    the new content arrives, producing a visible blank flash.
 *
 * This addon addresses both:
 * - Scroll preservation: saves `viewportY` and `baseY` at block entry and
 *   restores the equivalent position on exit via `setTimeout(0)`, adjusting
 *   for `baseY` growth caused by ED2 pushing screen rows into scrollback.
 * - Flicker suppression: registers a CSI J handler that intercepts ED2 inside
 *   sync blocks and returns `true` (suppress) so xterm skips the blank-screen
 *   paint. AI agents always follow ED2 with a full redraw, so the suppression
 *   is transparent to the user.
 *
 * Workaround for xterm.js issue #5801 (fixed in upstream 7.x, not yet
 * available in the 6.x release line used by this plugin).
 */
export class SynchronizedOutputScrollAddon implements ITerminalAddon {
  readonly #disposer = new Functions({ async: false, settled: true });

  public activate(terminal: Terminal): void {
    let syncDepth = 0;
    let savedViewportY = 0;
    let savedBaseY = 0;
    let savedAtBottom = false;

    // Register handler for ?2026h (begin synchronized output).
    // On the outermost entry, snapshot the current scroll state so it can be
    // restored when the block ends.
    const beginHandler = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        if (params[0] === 2026) {
          if (syncDepth === 0) {
            const { active } = terminal.buffer;
            savedViewportY = active.viewportY;
            savedBaseY = active.baseY;
            savedAtBottom = active.viewportY >= active.baseY;
          }
          syncDepth++;
        }
        // Return false so xterm still processes the sequence normally.
        return false;
      },
    );

    // Register handler for ?2026l (end synchronized output).
    // On the outermost exit, restore the saved scroll position after a tick so
    // that xterm has finished applying the buffered output.
    const endHandler = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        if (params[0] === 2026 && syncDepth > 0) {
          syncDepth--;
          if (syncDepth === 0) {
            const vY = savedViewportY;
            const bY = savedBaseY;
            const atBottom = savedAtBottom;
            setTimeout(() => {
              if (atBottom) {
                terminal.scrollToBottom();
              } else {
                const { active } = terminal.buffer;
                // Adjust for baseY growth: ED2 pushes old screen rows into
                // scrollback, incrementing baseY. Preserve the user's distance
                // from the top of scrollback by shifting viewportY by the same
                // delta.
                const delta = active.baseY - bY;
                terminal.scrollToLine(
                  Math.min(Math.max(0, vY + delta), active.baseY),
                );
              }
            }, 0);
          }
        }
        // Return false so xterm still processes the sequence normally.
        return false;
      },
    );

    // Register handler for CSI J (Erase in Display / ED).
    // While inside a synchronized-output block, suppress ED2 (\x1b[2J) so the
    // xterm.js canvas does not paint a blank screen between the clear and the
    // redrawn content (screen flicker). ED2 is always followed immediately by
    // fresh content from the agent, so suppressing it is safe.
    // Other ED variants (0 = to end, 1 = to start, 3 = scrollback) pass through.
    const eraseHandler = terminal.parser.registerCsiHandler(
      { final: "J" },
      (params) => {
        if (syncDepth > 0 && params[0] === 2) {
          // Suppress: inside a sync block; full-screen clear will be immediately
          // followed by a complete redraw from the agent.
          return true;
        }
        return false;
      },
    );

    this.#disposer.push(() => {
      beginHandler.dispose();
      endHandler.dispose();
      eraseHandler.dispose();
    });
  }

  public dispose(): void {
    this.#disposer.call();
  }
}
