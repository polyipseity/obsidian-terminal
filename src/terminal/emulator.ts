import {
  type Fixed,
  SI_PREFIX_SCALE,
  activeSelf,
  asyncDebounce,
  deepFreeze,
  dynamicRequire,
  dynamicRequireLazy,
  fixTyped,
  importable,
  launderUnchecked,
  markFixed,
} from "@polyipseity/obsidian-plugin-library";
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal,
} from "@xterm/xterm";
import { noop, throttle } from "es-toolkit/function";
// eslint-disable-next-line eslint-comments/no-restricted-disable -- See below.
// eslint-disable-next-line obsidianmd/no-nodejs-modules -- Type-only import.
import type { ChildProcessByStdio } from "node:child_process";
import type { AsyncOrSync } from "ts-essentials";
import { BUNDLE } from "../imports.js";
import {
  TERMINAL_EMULATOR_RESIZE_WAIT,
  TERMINAL_PTY_RESIZE_WAIT,
} from "../magic.js";
import { spawnPromise } from "../utils.js";
import { applyEnv } from "./environment.js";
import type { Pseudoterminal } from "./pseudoterminal.js";
import { writePromise } from "./utils.js";

const childProcess = dynamicRequire<typeof import("node:child_process")>(
    BUNDLE,
    "node:child_process",
  ),
  xterm = dynamicRequireLazy<typeof import("@xterm/xterm")>(
    BUNDLE,
    "@xterm/xterm",
  ),
  xtermAddonFit = dynamicRequireLazy<typeof import("@xterm/addon-fit")>(
    BUNDLE,
    "@xterm/addon-fit",
  ),
  xtermAddonSerialize = dynamicRequireLazy<
    typeof import("@xterm/addon-serialize")
  >(BUNDLE, "@xterm/addon-serialize");

export const SUPPORTS_EXTERNAL_TERMINAL_EMULATOR = importable(
  BUNDLE,
  "node:child_process",
);

export interface ExternalTerminalSpawnOptions {
  readonly cwd?: string | undefined;
  readonly environment?: readonly (readonly [string, string])[] | undefined;
}

export async function spawnExternalTerminalEmulator(
  executable: string,
  args?: readonly string[],
  options: ExternalTerminalSpawnOptions = {},
): Promise<ChildProcessByStdio<null, null, null>> {
  const { cwd, environment } = options;
  const childProcess2 = await childProcess;
  const ret = await spawnPromise(async () =>
    childProcess2.spawn(executable, args ?? [], {
      cwd,
      detached: true,
      env: await applyEnv({ fixed: "external", profile: environment }),
      shell: true,
      stdio: ["ignore", "ignore", "ignore"],
    }),
  );
  try {
    ret.unref();
  } catch (error) {
    self.console.warn(error);
  }
  return ret;
}

export class XtermTerminalEmulator<A> {
  public static readonly type = "xterm-256color";
  public readonly terminal;
  public readonly addons;
  public readonly pseudoterminal;

  protected readonly resizeEmulator = asyncDebounce(
    throttle(
      (
        resolve: (value: AsyncOrSync<void>) => void,
        reject: (reason?: unknown) => void,
        columns: number,
        rows: number,
      ) => {
        try {
          this.terminal.resize(columns, rows);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      TERMINAL_EMULATOR_RESIZE_WAIT * SI_PREFIX_SCALE,
    ),
  );

  protected readonly resizePTY = asyncDebounce(
    throttle(
      (
        resolve: (value: AsyncOrSync<void>) => void,
        _reject: (reason?: unknown) => void,
        columns: number,
        rows: number,
        mustResizePseudoterminal: boolean,
        xtermReady: Promise<void>,
      ) => {
        resolve(
          (async (): Promise<void> => {
            try {
              // The xterm resize lands before the backend resize.
              await xtermReady;
              const pty = await this.pseudoterminal;
              if (pty.resize) {
                await pty.resize(columns, rows);
              }
            } catch (error) {
              if (mustResizePseudoterminal) {
                throw error;
              }
              /* @__PURE__ */ activeSelf(this.terminal.element).console.debug(
                error,
              );
            }
          })(),
        );
      },
      TERMINAL_PTY_RESIZE_WAIT * SI_PREFIX_SCALE,
    ),
  );

  #running = true;
  readonly #ptyExit: Promise<void>;

  public constructor(
    protected readonly element: HTMLElement,
    pseudoterminal: (
      terminal: Terminal,
      addons: XtermTerminalEmulator<A>["addons"],
    ) => AsyncOrSync<Pseudoterminal>,
    state?: XtermTerminalEmulator.State,
    options?: ITerminalInitOnlyOptions & ITerminalOptions,
    addons?: A,
  ) {
    this.terminal = new xterm.Terminal(options);
    this.terminal.open(element);
    const { terminal } = this;

    const addons0 = Object.assign(
      {
        fit: new xtermAddonFit.FitAddon(),
        serialize: new xtermAddonSerialize.SerializeAddon(),
      },
      addons,
    );
    for (const addon of Object.values(addons0)) {
      terminal.loadAddon(addon);
    }
    this.addons = addons0;
    let write = Promise.resolve();
    if (state) {
      terminal.resize(state.columns, state.rows);
      write = writePromise(terminal, state.data).then(() => {
        // Restore scroll position after data is written
        // If user was at bottom, restore auto-scroll behavior
        if (
          state.scrollLine === XtermTerminalEmulator.State.SCROLL_LINE_BOTTOM
        ) {
          terminal.scrollToBottom();
          return;
        }
        // User was scrolled up - restore exact position with bounds checking
        const { active } = terminal.buffer,
          maxScrollY = Math.max(0, active.baseY - terminal.rows + 1),
          safeScrollLine = Math.min(Math.max(0, state.scrollLine), maxScrollY);
        terminal.scrollToLine(safeScrollLine);
      });
    }
    this.pseudoterminal = write.then(async () => {
      const pty0 = await pseudoterminal(terminal, addons0);
      await pty0.pipe(terminal);
      return pty0;
    });
    this.#ptyExit = this.pseudoterminal
      .then(async (pty0) => {
        await pty0.onExit;
      })
      .finally(() => {
        this.#running = false;
      })
      .catch(noop);
  }

  public async close(mustClosePseudoterminal = true): Promise<void> {
    let pseudoterminalCloseFailed = false;
    let pseudoterminalCloseError: unknown;
    try {
      if (this.#running) {
        await (await this.pseudoterminal).kill();
        await this.#ptyExit;
      }
    } catch (error) {
      pseudoterminalCloseFailed = true;
      pseudoterminalCloseError = error;
      if (!mustClosePseudoterminal)
        /* @__PURE__ */ activeSelf(this.terminal.element).console.debug(error);
    }
    // Dispose outer addons before xterm.
    for (const addon of Object.values(this.addons).reverse()) {
      try {
        addon.dispose();
      } catch (error) {
        /* @__PURE__ */ activeSelf(this.terminal.element).console.debug(error);
      }
    }
    try {
      this.terminal.dispose();
    } catch (error) {
      /* @__PURE__ */ activeSelf(this.terminal.element).console.debug(error);
    }
    if (mustClosePseudoterminal && pseudoterminalCloseFailed)
      throw pseudoterminalCloseError;
  }

  public async resize(mustResizePseudoterminal = true): Promise<void> {
    const { addons, resizeEmulator, resizePTY } = this,
      { fit } = addons,
      dim = fit.proposeDimensions();
    if (dim) {
      const { cols, rows } = dim;
      if (isFinite(cols) && isFinite(rows)) {
        const xtermReady = resizeEmulator(cols, rows);
        await Promise.all([
          xtermReady,
          resizePTY(cols, rows, mustResizePseudoterminal, xtermReady),
        ]);
      }
    }
  }

  public reopen(): void {
    const { element, terminal } = this;
    // Unnecessary: terminal.element?.remove()
    terminal.open(element);
  }

  public serialize(): XtermTerminalEmulator.State {
    const { normal } = this.terminal.buffer;
    let scrollLine = normal.viewportY;

    if (scrollLine === normal.baseY) {
      scrollLine = XtermTerminalEmulator.State.SCROLL_LINE_BOTTOM;
    }

    return deepFreeze({
      columns: this.terminal.cols,
      data: this.addons.serialize.serialize({
        excludeAltBuffer: true,
        excludeModes: true,
      }),
      rows: this.terminal.rows,
      scrollLine,
    });
  }
}
export namespace XtermTerminalEmulator {
  export interface State {
    readonly columns: number;
    readonly rows: number;
    readonly data: string;

    /** Line number, or {@link State.SCROLL_LINE_BOTTOM} to pin to the bottom. */
    readonly scrollLine: number;
  }
  export namespace State {
    export const SCROLL_LINE_BOTTOM = -1;
    export const DEFAULT: State = deepFreeze({
      columns: 1,
      data: "",
      rows: 1,
      scrollLine: SCROLL_LINE_BOTTOM,
    });
    export function fix(self0: unknown): Fixed<State> {
      const unc = launderUnchecked<State>(self0);
      return markFixed(self0, {
        columns: fixTyped(DEFAULT, unc, "columns", ["number"]),
        data: fixTyped(DEFAULT, unc, "data", ["string"]),
        rows: fixTyped(DEFAULT, unc, "rows", ["number"]),
        scrollLine: fixTyped(DEFAULT, unc, "scrollLine", ["number"]),
      });
    }
  }
}
