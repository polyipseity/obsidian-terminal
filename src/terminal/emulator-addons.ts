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
import type { ITerminalAddon, ITheme, Terminal } from "@xterm/xterm";
import { constant, isUndefined } from "lodash-es";
import type { CanvasAddon } from "@xterm/addon-canvas";
import type { WebglAddon } from "@xterm/addon-webgl";
import { around } from "monkey-around";
import { noop } from "ts-essentials";

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
    const update = (): void => {
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
      terminal.options.theme = {
        ...(terminal.options.theme ?? {}),
        background: next.background,
        cursor: next.cursor,
        foreground: next.foreground,
        selectionBackground: next.selectionBackground,
      };
    };

    // Initial apply
    update();

    const {
        app,
        app: { workspace },
      } = this.context,
      // Keep in sync with app CSS/theme changes (no throttling)
      // Obsidian already takes care of system-level theme changes
      ref = workspace.on("css-change", update);
    this.#disposer.push(() => {
      workspace.offref(ref);
    });

    revealPrivate(
      this.context,
      [app],
      (app2) => {
        // Patch app.setAccentColor to invoke update after it runs
        const unpatchSetAccent = around(app2, {
          setAccentColor(next) {
            return function patched(
              this: typeof app,
              ...args: Parameters<typeof next>
            ): ReturnType<typeof next> {
              next.apply(this, args);
              update();
            };
          },
        });
        this.#disposer.push(unpatchSetAccent);
      },
      noop,
    );
  }

  public dispose(): void {
    this.#disposer.call();
  }

  // -------------------------------------------------------------------------
  // Private instance methods (after public members)
  // -------------------------------------------------------------------------

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
 * Addon to fix Option key handling on macOS for international keyboards.
 *
 * ROOT CAUSE: xterm.js has a known bug (issue #2831) where macOptionIsMeta: false
 * is not properly respected. Even with the correct settings, xterm.js still sends
 * ESC sequences instead of allowing the browser to compose special characters
 * (e.g., Option+2 → @ on Finnish keyboards).
 *
 * This addon works around the bug by:
 * 1. Intercepting Option+key events before xterm.js processes them
 * 2. Sending the browser-composed character directly to the terminal
 * 3. Returning false to prevent xterm.js from sending ESC sequences
 */
export class MacOptionKeyAddon implements ITerminalAddon {
  #isDisposed = false;

  public constructor(
    protected readonly isMac: boolean,
    protected readonly isPassthroughEnabled: () => boolean,
  ) {}

  public activate(terminal: Terminal): void {
    const handler = (event: KeyboardEvent): boolean => {
      // Don't process events if addon is disposed
      if (this.#isDisposed) {
        return true;
      }

      // Only intercept on Mac when passthrough is enabled
      // (macOptionIsMeta is auto-disabled when passthrough is enabled)
      if (!this.isMac || !this.isPassthroughEnabled()) {
        return true; // Let xterm.js handle normally
      }

      // Only intercept Option+key (not Option alone, not with Cmd/Ctrl)
      if (!event.altKey || event.metaKey || event.ctrlKey) {
        return true;
      }

      // Only handle keydown events (not keyup)
      if (event.type !== "keydown") {
        return false; // Block keyup to prevent duplicate handling
      }

      // Ignore the Option key press itself
      if (event.key === "Alt") {
        return false; // Block to prevent any ESC sequence for modifier alone
      }

      // The browser has already composed the character in event.key
      // (e.g., Option+2 → '@', Option+7 → '|' on Finnish keyboard)
      // Send this character directly to the terminal using xterm.js internal API
      // NOTE: We access _core directly each time (not cached) to avoid holding
      // references that become invalid during disposal
      if (event.key.length === 1) {
        try {
          const core = (
            terminal as unknown as {
              _core?: {
                coreService?: {
                  triggerDataEvent: (
                    data: string,
                    wasUserInput: boolean,
                  ) => void;
                };
              };
            }
          )._core;
          if (core?.coreService) {
            core.coreService.triggerDataEvent(event.key, true);
          }
        } catch {
          // Terminal may be in an invalid state - silently ignore
        }
      }

      // Return false to prevent xterm.js from processing this event
      // (which would incorrectly send ESC sequences due to bug #2831)
      return false;
    };

    terminal.attachCustomKeyEventHandler(handler);
  }

  public dispose(): void {
    this.#isDisposed = true;
  }
}
