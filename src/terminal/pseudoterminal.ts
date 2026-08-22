import {
  Functions,
  Platform,
  ResourceComponent,
  SI_PREFIX_SCALE,
  acquireConditionally,
  activeSelf,
  anyToError,
  asyncFunction,
  attachFunctionSourceMap,
  clear,
  consumeEvent,
  deepFreeze,
  deopaque,
  dynamicRequire,
  getKeyModifiers,
  inSet,
  launderUnchecked,
  lazyInit,
  logFormat,
  multireplace,
  notice2,
  printError,
  promisePromise,
  remove,
  replaceAllRegex,
  sleep2,
  toJSONOrString,
  typedKeys,
} from "@polyipseity/obsidian-plugin-library";
import type { IMarker, Terminal } from "@xterm/xterm";
import { type Program, parse } from "acorn";
import inspect, { type Options } from "browser-util-inspect";
import { isEmpty, isNil, noop } from "es-toolkit/compat";
import {
  DEFAULT_ENCODING,
  EXIT_SUCCESS,
  MAX_LOCK_PENDING,
  TERMINAL_CONPTY_HOST_EXIT_WAIT,
  TERMINAL_CONPTY_RESIZE_REPAINT_WINDOW,
  TERMINAL_EXIT_CLEANUP_WAIT,
  TERMINAL_OUTPUT_HIGH_WATER_BYTES,
  TERMINAL_OUTPUT_LOW_WATER_BYTES,
  TERMINAL_OUTPUT_WRITE_SLICE_BYTES,
  TERMINAL_RESIZER_WATCHDOG_WAIT,
  WINDOWS_CONHOST_PATH,
} from "../magic.js";
import { spawnPromise, writePromise } from "../utils.js";
import {
  CONTROL_SEQUENCE_INTRODUCER as CSI,
  CursoredText,
  NORMALIZED_LINE_FEED,
  TerminalTextArea,
  normalizeText,
  writePromise as tWritePromise,
} from "./utils.js";

import ansi from "ansi-escape-sequences";
import AsyncLock from "async-lock";
import type { ChildProcessWithoutNullStreams as PipedChildProcess } from "node:child_process";
import type { DeveloperConsoleContext } from "obsidian-terminal";
import type { Position } from "source-map";
import type { FileResult } from "tmp-promise";
import type { AsyncOrSync } from "ts-essentials";
import { BUNDLE } from "../imports.js";
import type { TerminalPlugin } from "../main.js";
import type { Log } from "../patch.js";
// Type-only: erased at build, so the value import of `Pseudoterminal` in
// `settings-data.ts` cannot become a runtime cycle.
import type { Settings } from "../settings-data.js";
import { DisposerAddon } from "./emulator-addons.js";
import { applyEnv } from "./environment.js";
import unixPseudoterminalPy from "./unix_pseudoterminal.py";
import win32ConPtyPy from "./win32_conpty.py";
import win32ResizerPy from "./win32_resizer.py";

const childProcess = dynamicRequire<typeof import("node:child_process")>(
    BUNDLE,
    "node:child_process",
  ),
  crypto = dynamicRequire<typeof import("node:crypto")>(BUNDLE, "node:crypto"),
  fsPromises = dynamicRequire<typeof import("node:fs/promises")>(
    BUNDLE,
    "node:fs/promises",
  ),
  net = dynamicRequire<typeof import("node:net")>(BUNDLE, "node:net"),
  os = dynamicRequire<typeof import("node:os")>(BUNDLE, "node:os"),
  path = dynamicRequire<typeof import("node:path")>(BUNDLE, "node:path"),
  stream = dynamicRequire<typeof import("node:stream")>(BUNDLE, "node:stream"),
  url = dynamicRequire<typeof import("node:url")>(BUNDLE, "node:url"),
  tmpPromise = dynamicRequire<typeof import("tmp-promise")>(
    BUNDLE,
    "tmp-promise",
  );

export interface PausableStream {
  readonly pause: () => void;
  readonly resume: () => void;
}

export interface TerminalOutputBackpressure {
  /** Accounts one chunk given to `Terminal.write`. The promise must settle
   * when xterm has parsed the chunk. */
  readonly track: (chunk: Buffer | string, written: Promise<unknown>) => void;
  /** Stops accounting and resumes every paused source stream. */
  readonly dispose: () => void;
}

/**
 * Bounds the xterm write queue by pausing the source streams while too many
 * written bytes await parsing: pause above `highWaterBytes` of unparsed data,
 * resume below `lowWaterBytes`.
 */
export function createTerminalOutputBackpressure(
  streams: readonly PausableStream[],
  highWaterBytes = TERMINAL_OUTPUT_HIGH_WATER_BYTES,
  lowWaterBytes = TERMINAL_OUTPUT_LOW_WATER_BYTES,
): TerminalOutputBackpressure {
  let disposed = false,
    paused = false,
    pendingBytes = 0;
  const apply = (action: "pause" | "resume"): void => {
    for (const stream0 of streams) {
      try {
        stream0[action]();
      } catch (error) {
        /* @__PURE__ */ self.console.debug(error);
      }
    }
  };
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (paused) {
        paused = false;
        apply("resume");
      }
    },
    track(chunk, written): void {
      if (disposed) {
        return;
      }
      const size = typeof chunk === "string" ? chunk.length : chunk.byteLength;
      pendingBytes += size;
      if (!paused && pendingBytes > highWaterBytes) {
        paused = true;
        apply("pause");
      }
      const drain = (): void => {
        pendingBytes -= size;
        if (!disposed && paused && pendingBytes < lowWaterBytes) {
          paused = false;
          apply("resume");
        }
      };
      written.then(drain, drain);
    },
  };
}

/**
 * Writes one child chunk to xterm in bounded slices.
 *
 * xterm parses each `Terminal.write` chunk as one uninterruptible task and
 * checks its frame budget only between chunks, so the chunk size delivered by
 * the pipe decides renderer long-task length. Bounded slices let the renderer
 * interleave frames with parsing no matter how large the pipe's delivery was.
 * Byte- and code-unit-boundary splits are safe: xterm's streaming decoders
 * carry partial UTF-8 sequences and split surrogates across writes.
 *
 * The returned promise settles after xterm has parsed every slice.
 */
export async function writeTerminalSliced(
  terminal: Terminal,
  chunk: Buffer | string,
  sliceBytes = TERMINAL_OUTPUT_WRITE_SLICE_BYTES,
): Promise<void> {
  const length = typeof chunk === "string" ? chunk.length : chunk.byteLength;
  if (length <= sliceBytes) {
    return tWritePromise(terminal, chunk);
  }
  const writes: Promise<void>[] = [];
  for (let offset = 0; offset < length; offset += sliceBytes) {
    writes.push(
      tWritePromise(
        terminal,
        typeof chunk === "string"
          ? chunk.slice(offset, offset + sliceBytes)
          : chunk.subarray(offset, offset + sliceBytes),
      ),
    );
  }
  await Promise.all(writes);
}

export interface ResizeRepaintWindow {
  /** Restarts the window at the current time. */
  readonly arm: () => void;
  /** True while the window is open. */
  readonly active: () => boolean;
}

/** Tracks the span after a resize in which chunks are written unsliced (see
 * `TERMINAL_CONPTY_RESIZE_REPAINT_WINDOW`). */
export function createResizeRepaintWindow(
  windowSeconds: number,
  now: () => number = monotonicNowMs,
): ResizeRepaintWindow {
  let lastArmMs = Number.NEGATIVE_INFINITY;
  return {
    active: (): boolean => now() - lastArmMs < windowSeconds * SI_PREFIX_SCALE,
    arm: (): void => {
      lastArmMs = now();
    },
  };
}

/** Mirrors a child's stderr to the developer console, best effort. The
 * Python helpers write only failures there. */
export function logChildStderr(child: PipedChildProcess): void {
  try {
    child.stderr.on("data", (chunk: Buffer | string) => {
      self.console.error(chunk.toString(DEFAULT_ENCODING));
    });
  } catch (error) {
    self.console.warn(error);
  }
}

async function clearTerminal(terminal: Terminal, keep = false): Promise<void> {
  const { rows } = terminal;
  await tWritePromise(
    terminal,
    `${
      keep ? NORMALIZED_LINE_FEED.repeat(Math.max(rows - 1, 0)) : ""
    }${ansi.erase.display(keep ? 2 : 3)}${ansi.cursor.position()}`,
  );
}

export interface PipeShellToTerminalOptions {
  /** While active, chunks bypass write slicing. */
  readonly repaintWindow?: Pick<ResizeRepaintWindow, "active"> | undefined;
  /** Drops the first output chunk unwritten and untracked. */
  readonly skipFirstChunk?: boolean | undefined;
}

/**
 * Wires one spawned shell to a terminal: sliced, backpressured output from
 * `outputs`, keyboard input into `shell.stdin`, and cleanup tied to both the
 * terminal's disposal and `onExit`.
 */
export async function pipeShellToTerminal(
  terminal: Terminal,
  shell: PipedChildProcess,
  outputs: readonly PipedChildProcess["stdout"][],
  onExit: Promise<unknown>,
  options?: PipeShellToTerminalOptions,
): Promise<void> {
  let skipNextChunk = options?.skipFirstChunk ?? false;
  const repaintWindow = options?.repaintWindow,
    backpressure = createTerminalOutputBackpressure(outputs),
    reader = (chunk: Buffer | string): void => {
      if (skipNextChunk) {
        skipNextChunk = false;
        return;
      }
      const sliceBytes =
          (repaintWindow?.active() ?? false)
            ? Number.POSITIVE_INFINITY
            : void 0,
        written = writeTerminalSliced(terminal, chunk, sliceBytes);
      backpressure.track(chunk, written);
      written.catch((error: unknown) => {
        activeSelf(terminal.element).console.error(error);
      });
    };
  await clearTerminal(terminal, true);
  terminal.loadAddon(
    new DisposerAddon(
      ...outputs.map((output) => (): void => {
        output.removeListener("data", reader);
      }),
      () => {
        backpressure.dispose();
      },
    ),
  );
  for (const output of outputs) {
    output.on("data", reader);
  }
  const writer = terminal.onData(async (data) =>
    writePromise(shell.stdin, data),
  );
  onExit.catch(noop satisfies () => unknown as () => unknown).finally(() => {
    writer.dispose();
  });
}

/** True while the child has neither exited nor been signalled. */
function isRunning(child: {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export interface Pseudoterminal {
  readonly shell?: Promise<PipedChildProcess> | undefined;
  readonly kill: () => AsyncOrSync<void>;
  readonly onExit: Promise<NodeJS.Signals | number>;
  readonly pipe: (terminal: Terminal) => AsyncOrSync<void>;
  readonly resize?: (columns: number, rows: number) => AsyncOrSync<void>;
}

export class RefPsuedoterminal<
  T extends Pseudoterminal,
> implements Pseudoterminal {
  public readonly onExit;
  protected readonly delegate: T;
  readonly #exit = promisePromise<NodeJS.Signals | number>();
  readonly #ref: [number];

  public constructor(delegate: RefPsuedoterminal<T> | T) {
    this.onExit = this.#exit.then(async ({ promise }) => promise);
    if (delegate instanceof RefPsuedoterminal) {
      this.delegate = delegate.delegate;
      this.#ref = delegate.#ref;
    } else {
      this.delegate = delegate;
      this.#ref = [0];
    }
    this.delegate.onExit.then(
      async (ret) => {
        (await this.#exit).resolve(ret);
      },
      async (error: unknown) => {
        (await this.#exit).reject(error);
      },
    );
    ++this.#ref[0];
  }

  public get shell(): Promise<PipedChildProcess> | undefined {
    return this.delegate.shell;
  }

  public dup(): RefPsuedoterminal<T> {
    return new RefPsuedoterminal(this);
  }

  public async kill(): Promise<void> {
    if (--this.#ref[0] <= 0) {
      await this.delegate.kill();
    } else {
      (await this.#exit).resolve(EXIT_SUCCESS);
    }
  }

  public pipe(terminal: Terminal): AsyncOrSync<void> {
    return this.delegate.pipe(terminal);
  }

  public resize(columns: number, rows: number): AsyncOrSync<void> {
    const { delegate } = this;
    return delegate.resize?.(columns, rows);
  }
}

abstract class PseudoPseudoterminal implements Pseudoterminal {
  public readonly onExit;
  protected readonly terminals: Terminal[] = [];
  protected exited = false;
  readonly #exit = promisePromise<NodeJS.Signals | number>();

  public constructor() {
    this.onExit = this.#exit
      .then(async ({ promise }) => promise)
      .finally(() => {
        this.exited = true;
      })
      .finally(() => {
        clear(this.terminals);
      });
  }

  public async kill(): Promise<void> {
    (await this.#exit).resolve(EXIT_SUCCESS);
  }

  public pipe(terminal: Terminal): AsyncOrSync<void> {
    if (this.exited) {
      throw new Error();
    }
    terminal.loadAddon(
      new DisposerAddon(() => {
        remove(this.terminals, terminal);
      }),
    );
    this.terminals.push(terminal);
  }
}

export class TextPseudoterminal
  extends PseudoPseudoterminal
  implements Pseudoterminal
{
  protected static readonly syncLock = "sync";
  protected readonly lock = new AsyncLock({ maxPending: MAX_LOCK_PENDING });
  #text: string;

  public constructor(text = "") {
    super();
    this.#text = text;
  }

  public get text(): string {
    return this.#text;
  }

  public set text(value: string) {
    this.rewrite(normalizeText((this.#text = value))).catch(
      (error: unknown) => {
        self.console.error(error);
      },
    );
  }

  public override async pipe(terminal: Terminal): Promise<void> {
    await super.pipe(terminal);
    await this.rewrite(normalizeText(this.text), [terminal]);
  }

  protected async rewrite(
    text: string,
    terminals: readonly Terminal[] = this.terminals,
  ): Promise<void> {
    const terminals0 = [...terminals];
    return new Promise((resolve, reject: (reason?: unknown) => void) => {
      this.lock
        .acquire(TextPseudoterminal.syncLock, async () => {
          const writers = terminals0.map(async (terminal) => {
            await clearTerminal(terminal);
            await tWritePromise(terminal, text);
          });
          resolve(Promise.all(writers).then(noop));
          await Promise.allSettled(writers);
        })
        .catch(reject);
    });
  }
}

export class DeveloperConsolePseudoterminal
  extends PseudoPseudoterminal
  implements Pseudoterminal
{
  public static readonly colors = deepFreeze({
    debug: "blue",
    error: "red",
    info: "white",
    warn: "yellow",
  }) satisfies Record<string, ansi.Style>;

  protected static readonly syncLock = "sync";
  protected static readonly contextVar = "$$";
  protected readonly context: DeveloperConsoleContext;

  protected readonly lock = new AsyncLock({ maxPending: MAX_LOCK_PENDING });
  protected readonly buffer = new TerminalTextArea();
  readonly #formatCache = new WeakMap<Log.Event, string>();
  readonly #history = [""];
  #historyIndex = 0;
  readonly #results: unknown[] = [];
  readonly #editors = new Map<
    Terminal,
    DeveloperConsolePseudoterminal.$Editor
  >();

  public constructor(
    protected readonly self0: () => Window & typeof window,
    protected readonly log: Log,
    protected readonly sourceRoot = "",
  ) {
    super();
    const { terminals } = this,
      history = this.#history,
      results = this.#results;
    this.context = Object.seal({
      depth: 0,
      get history() {
        return history.slice(0, -1);
      },
      // Modifiable.
      get results() {
        return results;
      },
      get terminals() {
        return [...terminals];
      },
    });
    this.onExit
      .catch(noop satisfies () => unknown as () => unknown)
      .finally(log.logger.listen(async (event) => this.write([event])))
      .finally(() => {
        new Functions(
          { async: false, settled: true },
          ...[...this.#editors.keys()].map((terminal) => (): void => {
            this.#setEditor(terminal);
          }),
        ).call();
      })
      .finally(() => {
        this.buffer.dispose();
      });
  }

  public override async pipe(terminal: Terminal): Promise<void> {
    await super.pipe(terminal);
    terminal.loadAddon(
      new DisposerAddon(() => {
        this.#setEditor(terminal);
      }),
    );
    const { buffer, lock, terminals } = this;
    let block = false,
      resizing = false;
    const disposer = new Functions(
      { async: false, settled: true },
      ...[
        terminal.onData(async (data) => {
          if (block) {
            block = false;
            return;
          }
          await lock.acquire(
            DeveloperConsolePseudoterminal.syncLock,
            async () => {
              let writing = true;
              const write = buffer
                .write(data)
                .finally(() => {
                  writing = false;
                })
                .then(async () => {
                  this.#history[this.#history.length - 1] = buffer.value.string;
                  await this.syncBuffer(terminals, false);
                });

              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The write callbacks clear `writing` while `syncBuffer` is awaited.
              while (writing) {
                await this.syncBuffer(terminals, false);
              }
              await write;
            },
          );
        }),
        terminal.onKey(({ domEvent }) => {
          if (!isEmpty(getKeyModifiers(domEvent))) {
            return;
          }
          function logError(error: unknown): void {
            activeSelf(domEvent).console.error(error);
          }
          const { key } = domEvent;
          switch (key) {
            case "Enter":
              this.eval().catch(logError);
              break;
            case "ArrowUp":
            case "ArrowDown":
              if (
                (this.#history[this.#history.length - 1] ?? "").includes("\n")
              ) {
                return;
              }
              lock
                .acquire(DeveloperConsolePseudoterminal.syncLock, async () => {
                  const { length } = this.#history;
                  if (
                    length <= 0 ||
                    (this.#history[length - 1] ?? "").includes("\n")
                  ) {
                    return;
                  }
                  this.#historyIndex += length + (key === "ArrowDown" ? 1 : -1);
                  this.#historyIndex %= length;
                  const text = this.#history[this.#historyIndex];
                  if (text === void 0) {
                    return;
                  }
                  let writing = true;
                  const write = buffer
                    .setValue(text)
                    .finally(() => {
                      writing = false;
                    })
                    .then(async () => this.syncBuffer(terminals, false));

                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The write callbacks clear `writing` while `syncBuffer` is awaited.
                  while (writing) {
                    await this.syncBuffer(terminals, false);
                  }
                  await write;
                })
                .catch(logError);
              break;
            default:
              return;
          }
          block = true;
          consumeEvent(domEvent);
        }),
        terminal.onResize(() => {
          if (resizing) {
            return;
          }
          resizing = true;
          this.syncBuffer([terminal])
            .finally(() => {
              resizing = false;
            })
            .catch((error: unknown) => {
              activeSelf(terminal.element).console.error(error);
            });
        }),
      ].map((disposer0) => (): void => {
        disposer0.dispose();
      }),
    );
    this.onExit
      .catch(noop satisfies () => unknown as () => unknown)
      .finally(() => {
        disposer.call();
      });
    await this.write(this.log.history, [terminal]);
  }

  protected format(event: Log.Event): string {
    let ret = this.#formatCache.get(event);
    if (ret === void 0) {
      const { colors } = DeveloperConsolePseudoterminal,
        { data, type } = event,
        styles: ansi.Style[] = [];
      switch (type) {
        case "debug":
        case "error":
        case "info":
        case "warn":
          styles.push(colors[type]);
          ret = logFormat(this.options(styles), ...data);
          break;
        case "windowError":
          styles.push(colors.error);
          ret = logFormat(this.options(styles), data.message, data);
          break;
        case "unhandledRejection":
          styles.push(colors.error);
          ret = logFormat(this.options(styles), data.reason, data);
          break;
        // No default
      }
      this.#formatCache.set(
        event,
        (ret = `${ansi.styles(styles)}${ret}${ansi.style.reset}`),
      );
    }
    return ret;
  }

  protected options(styles: readonly ansi.Style[]): Options {
    const {
      context: { depth },
    } = this;
    return deepFreeze({
      customInspect: false,
      depth,
      showHidden: true,
      stylize(str, styleType) {
        const { [styleType]: style } = inspect.styles;
        if (style) {
          const {
            [style]: [apply, undo],
          } = inspect.colors;
          return `${CSI}${String(apply)}m${str}${CSI}${String(undo)}m${ansi.styles(styles)}`;
        }
        return str;
      },
    });
  }

  protected async eval(): Promise<void> {
    const { buffer, context, lock, self0, sourceRoot, terminals } = this,
      results = this.#results,
      self1 = self0(),
      code = await lock.acquire(
        DeveloperConsolePseudoterminal.syncLock,
        async () => {
          const { string: ret } = await buffer.clear(),
            { length } = this.#history;
          this.#history.splice(length - 1, 1, ret, "");
          this.#historyIndex = length;
          await this.syncBuffer(terminals, false);
          return ret;
        },
      );
    self1.console.log(code);
    const ast = ((): Program | null => {
      try {
        return parse(code, {
          allowAwaitOutsideFunction: true,
          allowHashBang: true,
          allowImportExportEverywhere: false,
          allowReserved: true,
          allowReturnOutsideFunction: false,
          allowSuperOutsideMethod: false,
          ecmaVersion: "latest",
          locations: true,
          preserveParens: false,
          ranges: false,
          sourceType: "script",
        });
      } catch (error) {
        self1.console.error(error);
        return null;
      }
    })();
    if (!ast) {
      return;
    }
    const lastStmt = ast.body[ast.body.length - 1],
      codeRet = lastStmt
        ? `${code.slice(0, lastStmt.start)}return [(${code.slice(
            lastStmt.start,
          )})]`
        : "",
      lastStmtLoc = lastStmt?.loc,
      codeRetDeletions: Position[] = [];
    if (lastStmtLoc) {
      const { start, end } = lastStmtLoc;
      let column = 0;
      // eslint-disable-next-line no-empty-pattern -- Iterate once per character; only the count matters.
      for (const {} of "return [(") {
        codeRetDeletions.push({
          column: start.column + column,
          line: start.line,
        });
        ++column;
      }
      if (start.line !== end.line) {
        column = 0;
      }
      // eslint-disable-next-line no-empty-pattern -- Iterate once per character; only the count matters.
      for (const {} of ")]") {
        codeRetDeletions.push({
          column: end.column + column,
          line: end.line,
        });
        ++column;
      }
    }
    async function evaluate(
      script: string,
      deletions: readonly Position[] = [],
    ): Promise<unknown> {
      const ctor = asyncFunction(self1);

      return new ctor(
        DeveloperConsolePseudoterminal.contextVar,
        attachFunctionSourceMap(ctor, script, {
          deletions,
          file: "<stdin>",
          sourceRoot: `${sourceRoot}${sourceRoot && "/"}<stdin>`,
        }),
      )(context);
    }
    const [hasError, ret] = await (async (): Promise<[boolean, unknown]> => {
      if (codeRet) {
        try {
          const ret2: unknown = await evaluate(codeRet, codeRetDeletions);
          if (!Array.isArray(ret2) || ret2.length !== 1) {
            throw new Error(String(ret2));
          }
          return [false, ret2[0]];
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            self1.console.error(error);
            return [true, error];
          }
          /* @__PURE__ */ self1.console.debug(error);
        }
      }
      try {
        // Cannot grab the result.
        return [false, await evaluate(code)];
      } catch (error) {
        self1.console.error(error);
        return [true, error];
      }
    })();
    results.push(ret);
    if (hasError) {
      return;
    }
    self1.console.log(ret);
  }

  protected async syncBuffer(
    terminals: readonly Terminal[] = this.terminals,
    lock = true,
  ): Promise<void> {
    const terminals0 = [...terminals];
    return new Promise((resolve, reject: (reason?: unknown) => void) => {
      acquireConditionally(
        this.lock,
        DeveloperConsolePseudoterminal.syncLock,
        lock,
        async () => {
          const writers = terminals0.map(async (terminal) => {
            const editor = this.#editors.get(terminal),
              info = await CursoredText.info(
                terminal,
                this.buffer.value,
                editor?.startX,
              ),
              {
                rows,
                buffer: { active },
              } = terminal,
              { baseY } = active,
              startBaseY = editor?.startYMarker?.line ?? baseY,
              lastRenderEndY = editor?.renderEndY ?? 0,
              renderRows = Math.min(info.rows, rows),
              renderStartY = info.rows - renderRows,
              prerenderStartY = startBaseY + lastRenderEndY - baseY,
              skipPreRenderRows = Math.max(-prerenderStartY, 0),
              firstUp = renderRows - 1,
              secondUp = info.rows - 1 - info.cursor[1];
            await tWritePromise(
              terminal,
              `${ansi.cursor.position(
                1 + prerenderStartY + skipPreRenderRows,
                1 + (lastRenderEndY > 0 ? 0 : info.startX),
              )}${ansi.erase.display()}${info.lines
                .slice(lastRenderEndY + skipPreRenderRows, info.rows)
                .join(NORMALIZED_LINE_FEED)}${ansi.cursor.horizontalAbsolute(
                1 + (renderStartY > 0 ? 0 : info.startX),
              )}${
                firstUp > 0 ? ansi.cursor.up(firstUp) : ""
              }${ansi.erase.display()}${info.lines
                .slice(renderStartY, info.rows)
                .join(NORMALIZED_LINE_FEED)}${ansi.cursor.horizontalAbsolute(
                1 + (info.cursor[1] < renderStartY ? 0 : info.cursor[0]),
              )}${secondUp > 0 ? ansi.cursor.up(secondUp) : ""}`,
            );
            if (editor) {
              editor.renderEndY = info.rows - 1;
            }
          });
          resolve(Promise.all(writers).then(noop));
          await Promise.allSettled(writers);
        },
      ).catch(reject);
    });
  }

  protected async write(
    events: readonly Log.Event[],
    terminals: readonly Terminal[] = this.terminals,
    lock = true,
  ): Promise<void> {
    const terminals0 = [...terminals],
      text = `${
        ansi.erase.inLine() +
        normalizeText(
          events.map((event) => this.format(event)).join("\n"),
        ).replace(
          replaceAllRegex(NORMALIZED_LINE_FEED),
          `${NORMALIZED_LINE_FEED}${ansi.erase.inLine()}`,
        )
      }${NORMALIZED_LINE_FEED}`;
    await acquireConditionally(
      this.lock,
      DeveloperConsolePseudoterminal.syncLock,
      lock,
      async () => {
        await Promise.allSettled(
          terminals0.map(async (terminal) => {
            const {
                buffer: { active },
              } = terminal,
              editor = this.#editors.get(terminal),
              { baseY } = active,
              startBaseY = editor?.startYMarker?.line ?? baseY + active.cursorY;
            await tWritePromise(
              terminal,
              `${ansi.cursor.position(
                1 + (startBaseY - baseY),
                1,
              )}${ansi.erase.display()}${text}`,
            );
            this.#setEditor(terminal, {
              close() {
                this.startYMarker?.dispose();
              },
              renderEndY: 0,
              startX: active.cursorX,
              startYMarker: terminal.registerMarker(),
            });
          }),
        );
        await this.syncBuffer(terminals0, false);
      },
    );
  }

  #setEditor(
    terminal: Terminal,
    editor?: DeveloperConsolePseudoterminal.$Editor,
  ): void {
    this.#editors.get(terminal)?.close();
    if (editor) {
      this.#editors.set(terminal, editor);
    } else {
      this.#editors.delete(terminal);
    }
  }
}
export namespace DeveloperConsolePseudoterminal {
  export interface $Editor {
    readonly startX: number;
    readonly startYMarker: IMarker | undefined;
    renderEndY: number;
    readonly close: () => void;
  }
  export class Manager extends ResourceComponent<Manager.Type> {
    public constructor(protected readonly context: TerminalPlugin) {
      super();
    }

    protected override async load0(): Promise<Manager.Type> {
      const {
          context: {
            earlyPatch: { onLoaded },
            manifest: { id },
          },
        } = this,
        { log } = await onLoaded,
        ret = lazyInit(
          () =>
            new RefPsuedoterminal(
              new DeveloperConsolePseudoterminal(
                activeSelf,
                log,
                `plugin:${id}`,
              ),
            ),
        );
      this.register(async () => ret().kill());
      // Cannot use `lazyProxy`, the below `return` accesses `ret.then`
      return ret;
    }
  }
  export namespace Manager {
    export type Type = () => RefPsuedoterminal<DeveloperConsolePseudoterminal>;
  }
}

export interface ShellPseudoterminalArguments {
  readonly executable: string;
  readonly cwd?: URL | string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly environment?: readonly (readonly [string, string])[] | undefined;
  readonly pythonExecutable?: string | undefined;
  readonly win32Backend?: Settings.Profile.Win32Backend | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}

export class WindowsPseudoterminal implements Pseudoterminal {
  public readonly shell;
  public readonly onExit;
  protected readonly resizer;

  async #closeResizer(): Promise<void> {
    const resizer = await this.resizer.catch(() => null);
    if (!resizer || !isRunning(resizer)) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      resizer.once("exit", () => {
        resolve();
      });
    });
    resizer.stdin.end();
    const closedGracefully = await Promise.race([
      exited.then(() => true),
      sleep2(self, TERMINAL_RESIZER_WATCHDOG_WAIT).then(() => false),
    ]);
    if (closedGracefully) return;
    resizer.kill();
    const killed = await Promise.race([
      exited.then(() => true),
      sleep2(self, TERMINAL_EXIT_CLEANUP_WAIT).then(() => false),
    ]);
    if (!killed) {
      throw new Error(
        this.context.language.value.t("errors.error-killing-pseudoterminal"),
      );
    }
  }

  public constructor(
    protected readonly context: TerminalPlugin,
    {
      args,
      cwd,
      environment,
      executable,
      pythonExecutable,
    }: ShellPseudoterminalArguments,
  ) {
    const {
        language: { value: i18n },
        settings,
      } = context,
      resizerInitial = (async (): Promise<PipedChildProcess | null> => {
        if (isNil(pythonExecutable)) {
          return null;
        }
        try {
          const [childProcess2, win32ResizerPy2] = await Promise.all([
              childProcess,
              win32ResizerPy,
            ]),
            ret = await spawnPromise(async () =>
              childProcess2.spawn(pythonExecutable, ["-c", win32ResizerPy2], {
                env: await applyEnv(),
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              }),
            );
          ret.once("exit", (code, signal) => {
            // An ended stdin means the console exited and the resizer was
            // asked to stop: its exit is not a failure.
            if (code !== 0 && !ret.stdin.writableEnded) {
              notice2(
                () =>
                  i18n.t("errors.resizer-exited-unexpectedly", {
                    code: code ?? signal,
                    interpolation: { escapeValue: false },
                  }),
                settings.value.errorNoticeTimeout,
                context,
              );
            }
          });
          logChildStderr(ret);
          return ret;
        } catch (error) {
          self.console.warn(error);
          throw error;
        }
      })(),
      shell = (async (): Promise<
        readonly [PipedChildProcess, FileResult, typeof resizerInitial]
      > => {
        const resizer = await resizerInitial.catch(() => null);
        try {
          const [childProcess2, fsPromises2, tmpPromise2] = await Promise.all([
              childProcess,
              fsPromises,
              tmpPromise,
            ]),
            inOutTmp = await tmpPromise2.file({
              discardDescriptor: true,
              postfix: ".bat",
            });
          try {
            /*
             * The command is written to a file because...
             * `conhost.exe` "helpfully" escapes the arguments.
             *
             * <https://github.com/microsoft/terminal/blob/cb48babe9dfee5c3e830644eb7ee48f4116d3c47/src/host/ConsoleArguments.cpp#L34>
             */
            const inOutTmpEsc = WindowsPseudoterminal.escapeArgumentForBat(
              inOutTmp.path,
            );
            /*
             * The last command is a one-liner to prevent
             * "Terminate batch job (Y/N)?" from terminating
             * writing the exit code.
             */
            await fsPromises2.writeFile(
              inOutTmp.path,
              `@echo off\r\nsetlocal EnableDelayedExpansion\r\nset q=\\"\r\n${[
                executable,
                ...(args ?? []),
              ]
                .map((arg) => WindowsPseudoterminal.escapeArgumentForBat(arg))
                .join(" ")} & echo !ERRORLEVEL! > ${inOutTmpEsc}`,
              { encoding: DEFAULT_ENCODING, flag: "w" },
            );
            const ret = await spawnPromise(async () =>
              childProcess2.spawn(WINDOWS_CONHOST_PATH, [inOutTmp.path], {
                cwd,
                env: await applyEnv({ profile: environment }),
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: !resizer,
              }),
            );
            return [
              ret,
              inOutTmp,
              resizerInitial
                .then(async (resizer0) => {
                  if (resizer0) {
                    try {
                      await writePromise(
                        resizer0.stdin,
                        `${String(ret.pid ?? -1)}\n`,
                      );
                      let watchdog: number | undefined = self.setInterval(
                        () => {
                          writePromise(resizer0.stdin, "\n").catch(
                            (error: unknown) => {
                              /* @__PURE__ */ self.console.debug(error);
                              stopWatchdog();
                            },
                          );
                        },
                        TERMINAL_RESIZER_WATCHDOG_WAIT * SI_PREFIX_SCALE,
                      );
                      const stopWatchdog = (): void => {
                        if (watchdog === void 0) return;
                        self.clearInterval(watchdog);
                        watchdog = void 0;
                      };
                      resizer0.once("exit", stopWatchdog);
                      resizer0.once("error", stopWatchdog);
                      resizer0.once("close", stopWatchdog);
                      if (!isRunning(resizer0) || resizer0.stdin.writableEnded)
                        stopWatchdog();
                    } catch (error) {
                      resizer0.kill();
                      throw error;
                    }
                  }
                  return resizer0;
                })
                .catch((error: unknown) => {
                  const error0 = anyToError(error);
                  printError(
                    error0,
                    () => i18n.t("errors.error-spawning-resizer"),
                    context,
                  );
                  throw error0;
                }),
            ];
          } catch (error) {
            await inOutTmp.cleanup();
            throw error;
          }
        } catch (error) {
          resizer?.kill();
          throw error;
        }
      })();
    this.resizer = shell.then(async ([, , resizer]) => resizer);
    this.shell = shell.then(([shell0]) => shell0);
    this.onExit = shell.then(
      async ([shell0, inOutTmp]) =>
        new Promise<NodeJS.Signals | number>((resolve) => {
          shell0.once("exit", (conCode, signal) => {
            resolve(
              (async (): Promise<NodeJS.Signals | number> => {
                let exitCode: NodeJS.Signals | number;
                try {
                  const fsPromises2 = await fsPromises,
                    termCode = parseInt(
                      (
                        await fsPromises2.readFile(inOutTmp.path, {
                          encoding: DEFAULT_ENCODING,
                          flag: "r",
                        })
                      ).trim(),
                      10,
                    );
                  exitCode = isNaN(termCode)
                    ? (conCode ?? signal ?? NaN)
                    : termCode;
                } catch (error) {
                  /* @__PURE__ */ self.console.debug(error);
                  exitCode = conCode ?? signal ?? NaN;
                } finally {
                  void (async (): Promise<void> => {
                    try {
                      await sleep2(self, TERMINAL_EXIT_CLEANUP_WAIT);
                      await inOutTmp.cleanup();
                    } catch (error) {
                      self.console.warn(error);
                    }
                  })();
                }
                try {
                  await this.#closeResizer();
                } catch (error) {
                  // The exit code is already known; a resizer that ignores
                  // its kill must not turn a clean exit into an error.
                  self.console.warn(error);
                }
                return exitCode;
              })(),
            );
          });
        }),
    );
  }

  protected static escapeArgumentForBat(arg: string, quoteVar = "!q!"): string {
    return `"${multireplace(
      arg,
      new Map([
        ["^", "^^"],
        ["!", "^!"],
        ["%", "%%"],
        ['"', quoteVar],
      ]),
    )}"`;

    /*
     * Clusterfuck: <https://stackoverflow.com/a/31413730>
     *
     * 1. use `^` to escape `^` and `!`: <https://stackoverflow.com/a/5620353>
     * 2. use `%` to escape `%`: <https://stackoverflow.com/a/31413730>
     * 3. use `!q!` to replace `"`": <https://stackoverflow.com/a/31413730>
     * 4. enclose the argument in double quotes
     */
  }

  public async kill(): Promise<void> {
    if (!(await this.shell).kill()) {
      throw new Error(
        this.context.language.value.t("errors.error-killing-pseudoterminal"),
      );
    }
  }

  public async resize(columns: number, rows: number): Promise<void> {
    const { resizer } = this,
      resizer0 = await resizer;
    if (!resizer0) {
      // Resizer-less ConHost: the console keeps its size.
      return;
    }
    await writePromise(resizer0.stdin, `${String(columns)}x${String(rows)}\n`);
  }

  public async pipe(terminal: Terminal): Promise<void> {
    const shell = await this.shell;
    await pipeShellToTerminal(
      terminal,
      shell,
      [shell.stdout, shell.stderr],
      this.onExit,
      // conhost emits one junk frame while attaching its console.
      { skipFirstChunk: true },
    );
  }
}

class UnixPseudoterminal implements Pseudoterminal {
  static readonly #cmdio = 3;
  public readonly shell;
  public readonly onExit;

  public constructor(
    protected readonly context: TerminalPlugin,
    {
      args,
      cwd,
      environment,
      executable,
      pythonExecutable,
    }: ShellPseudoterminalArguments,
  ) {
    const { language } = context;
    this.shell = spawnPromise(async () => {
      if (isNil(pythonExecutable)) {
        throw new Error(
          language.value.t("errors.no-Python-to-spawn-Unix-pseudoterminal"),
        );
      }
      const [childProcess2, unixPseudoterminalPy2] = await Promise.all([
        childProcess,
        unixPseudoterminalPy,
      ]);
      return childProcess2.spawn(
        pythonExecutable,
        ["-c", unixPseudoterminalPy2, executable].concat(args ?? []),
        {
          cwd,
          env: await applyEnv({ profile: environment }),
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    }).then((ret) => {
      logChildStderr(ret);
      return ret;
    });
    this.onExit = this.shell.then(
      async (shell) =>
        new Promise<NodeJS.Signals | number>((resolve) => {
          shell.once("exit", (code, signal) => {
            resolve(code ?? signal ?? NaN);
          });
        }),
    );
  }

  public async kill(): Promise<void> {
    if (!(await this.shell).kill()) {
      throw new Error(
        this.context.language.value.t("errors.error-killing-pseudoterminal"),
      );
    }
  }

  public async pipe(terminal: Terminal): Promise<void> {
    const shell = await this.shell;
    await pipeShellToTerminal(
      terminal,
      shell,
      [shell.stdout, shell.stderr],
      this.onExit,
    );
  }

  public async resize(columns: number, rows: number): Promise<void> {
    const [shell, stream2] = await Promise.all([this.shell, stream]),
      cmdio = shell.stdio[UnixPseudoterminal.#cmdio];
    if (!(cmdio instanceof stream2.Writable)) {
      throw new TypeError(toJSONOrString(cmdio));
    }
    await writePromise(cmdio, `${String(columns)}x${String(rows)}\n`);
  }
}

/**
 * Environment variable carrying the control-channel authentication token.
 * The token never appears on the command line.
 */
const CONPTY_TOKEN_ENVIRONMENT_VARIABLE = "OBSIDIAN_TERMINAL_CONPTY_TOKEN";

const CONPTY_DEFAULT_COLUMNS = 120,
  CONPTY_DEFAULT_ROWS = 30,
  CONPTY_MAX_DIMENSION = 32_767,
  CONPTY_MAX_CONTROL_LINE = 4096,
  CONPTY_NEWLINE_BYTE = 0x0a,
  CONPTY_PIPE_PREFIX = "\\\\.\\pipe\\obsidian-terminal-conpty-",
  CONPTY_READY_ATTESTATION =
    "create-pseudoconsole+authenticated-control-channel+job-object-assigned";

/** Bounds spawn-to-ready. That span contains a cold interpreter boot, which
 * an antivirus scan of a first-seen source file can stretch far past five
 * seconds on slower machines. */
export const CONPTY_READY_TIMEOUT_MS = 10_000;

/*
 * Types only. A static `import ... from "node:net"` is rejected on mobile
 * builds; the runtime access goes through `dynamicRequire` above.
 */
type Net = typeof import("node:net");
type Server = ReturnType<Net["createServer"]>;
type Socket = InstanceType<Net["Socket"]>;

export interface ConPtyResizeOp {
  readonly op: "resize";
  readonly columns: number;
  readonly rows: number;
  /** Ack correlation sequence. The host echoes it in a `resized` event. */
  readonly seq?: number | undefined;
}
export interface ConPtyKillOp {
  readonly op: "kill";
}
export interface ConPtyAuthenticateOp {
  readonly op: "authenticate";
  readonly token: string;
}
/** Starts one session on a deferred (pre-booted, authenticated) host. */
export interface ConPtyStartOp {
  readonly op: "start";
  readonly columns: number;
  readonly rows: number;
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly command: readonly string[];
}
export type ConPtyOp =
  ConPtyAuthenticateOp | ConPtyKillOp | ConPtyResizeOp | ConPtyStartOp;

export interface ConPtyHelloEvent {
  readonly childPid: number;
  readonly event: "hello";
  readonly hostPid: number;
  readonly token: string;
}
export interface ConPtyReadyEvent {
  readonly attestation: typeof CONPTY_READY_ATTESTATION;
  readonly childPid: number;
  readonly controlChannelAuthenticated: true;
  readonly createPseudoConsole: true;
  readonly event: "ready";
  readonly hostPid: number;
  readonly jobObjectAssigned: true;
}
export interface ConPtyExitEvent {
  readonly event: "exit";
  readonly code: number;
}
/** Host acknowledgment that `ResizePseudoConsole` completed for `seq`. */
export interface ConPtyResizedEvent {
  readonly event: "resized";
  readonly columns: number;
  readonly rows: number;
  readonly seq: number;
}
/** A deferred host announcing itself before any session exists. */
export interface ConPtyIdleEvent {
  readonly event: "idle";
  readonly hostPid: number;
  readonly token: string;
}
export type ConPtyHostEvent =
  | ConPtyExitEvent
  | ConPtyHelloEvent
  | ConPtyIdleEvent
  | ConPtyReadyEvent
  | ConPtyResizedEvent;

/** Encodes one control operation as an NDJSON line. */
export function encodeConPtyOp(op: ConPtyOp): string {
  return `${JSON.stringify(op)}\n`;
}

interface ConPtyHostEventFields {
  readonly attestation: unknown;
  readonly childPid: unknown;
  readonly event: unknown;
  readonly hostPid: unknown;
  readonly controlChannelAuthenticated: unknown;
  readonly createPseudoConsole: unknown;
  readonly jobObjectAssigned: unknown;
  readonly token: unknown;
  readonly code: unknown;
  readonly columns: unknown;
  readonly rows: unknown;
  readonly seq: unknown;
}

function isConPtyDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= CONPTY_MAX_DIMENSION
  );
}

function isConPtyAckSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isProcessId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffff_ffff
  );
}

/** Parses one NDJSON line sent by the host. Returns `null` when the line is
 * not a known, well-formed event. */
export function parseConPtyHostEvent(line: string): ConPtyHostEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = ((): unknown => {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      /* @__PURE__ */ self.console.debug(error);
      return null;
    }
  })();
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const {
    attestation,
    childPid,
    code,
    columns,
    controlChannelAuthenticated,
    createPseudoConsole,
    event,
    hostPid,
    jobObjectAssigned,
    rows,
    seq,
    token,
  } = launderUnchecked<ConPtyHostEventFields>(parsed);
  if (event === "hello") {
    if (
      Object.keys(parsed).length !== 4 ||
      typeof token !== "string" ||
      token.length === 0 ||
      !isProcessId(hostPid) ||
      !isProcessId(childPid) ||
      hostPid === childPid
    ) {
      return null;
    }
    return Object.freeze({
      childPid,
      event,
      hostPid,
      token,
    });
  }
  if (event === "ready") {
    if (
      Object.keys(parsed).length !== 7 ||
      attestation !== CONPTY_READY_ATTESTATION ||
      controlChannelAuthenticated !== true ||
      createPseudoConsole !== true ||
      jobObjectAssigned !== true ||
      !isProcessId(hostPid) ||
      !isProcessId(childPid) ||
      hostPid === childPid
    ) {
      return null;
    }
    return Object.freeze({
      attestation,
      childPid,
      controlChannelAuthenticated,
      createPseudoConsole,
      event,
      hostPid,
      jobObjectAssigned,
    });
  }
  if (event === "exit") {
    if (
      Object.keys(parsed).length !== 2 ||
      typeof code !== "number" ||
      !Number.isSafeInteger(code) ||
      code < 0 ||
      code > 0xffff_ffff
    ) {
      return null;
    }
    return Object.freeze({ code, event });
  }
  if (event === "resized") {
    if (
      Object.keys(parsed).length !== 4 ||
      !isConPtyDimension(columns) ||
      !isConPtyDimension(rows) ||
      !isConPtyAckSequence(seq)
    ) {
      return null;
    }
    return Object.freeze({ columns, event, rows, seq });
  }
  if (event === "idle") {
    if (
      Object.keys(parsed).length !== 3 ||
      typeof token !== "string" ||
      token.length === 0 ||
      !isProcessId(hostPid)
    ) {
      return null;
    }
    return Object.freeze({ event, hostPid, token });
  }
  return null;
}

export interface ConPtyLines {
  readonly lines: readonly string[];
  readonly rest: Buffer;
  /** `true` when an unterminated line exceeded `maxLineLength` and was
   * dropped. The caller must treat the peer as broken. */
  readonly overflow: boolean;
}

/** Splits `previous + chunk` into complete NDJSON lines plus the remainder. */
export function splitConPtyLines(
  previous: Buffer,
  chunk: Buffer,
  maxLineLength = CONPTY_MAX_CONTROL_LINE,
): ConPtyLines {
  const lines: string[] = [];
  let rest: Buffer = Buffer.concat([previous, chunk]),
    newline = rest.indexOf(CONPTY_NEWLINE_BYTE);
  while (newline >= 0) {
    if (newline > maxLineLength) {
      return { lines, overflow: true, rest: Buffer.alloc(0) };
    }
    lines.push(
      rest.subarray(0, newline).toString(DEFAULT_ENCODING).replace(/\r$/u, ""),
    );
    rest = rest.subarray(newline + 1);
    newline = rest.indexOf(CONPTY_NEWLINE_BYTE);
  }
  if (rest.length > maxLineLength) {
    return { lines, overflow: true, rest: Buffer.alloc(0) };
  }
  return { lines, overflow: false, rest };
}

/** Clamps a terminal dimension to what ConPTY accepts. */
export function normalizeConPtyDimension(
  value: number | undefined,
  fallback: number,
): number {
  return Math.max(
    1,
    Math.min(
      CONPTY_MAX_DIMENSION,
      Math.trunc(value !== void 0 && isFinite(value) ? value : fallback),
    ),
  );
}

export class ConPtyControlError extends Error {
  public constructor(
    public readonly reason:
      "aborted" | "disconnected" | "protocol" | "timeout" | "unauthenticated",
    message?: string,
  ) {
    super(message ?? reason);
  }
}

export interface ConPtyControlChannel {
  /** Named pipe path. The server listens on it before the host spawns. */
  readonly path: string;
  readonly token: string;
  /** Resolves with the validated hello, rejects with a
   * {@link ConPtyControlError}. */
  readonly hello: Promise<ConPtyHelloEvent>;
  /** Resolves only after the authenticated ready event. */
  readonly ready: Promise<ConPtyReadyEvent>;
  /** Exit code reported by the host, or `null` when it never reported one. */
  readonly reportedExitCode: () => number | null;
  readonly kill: () => Promise<void>;
  readonly resize: (
    columns: number,
    rows: number,
    seq?: number,
  ) => Promise<void>;
  readonly dispose: () => Promise<void>;
  /** Called for each host `resized` acknowledgment. The acknowledgment marks
   * the host apply, so consumers time repaint handling from it. */
  onResized?: ((event: ConPtyResizedEvent) => void) | undefined;
}

export interface ConPtyControlDependencies {
  readonly createServer: () => Server;
  readonly randomUUID: () => string;
  readonly readyTimeoutMs?: number | undefined;
  /**
   * Builds the listening path from a random identifier. Defaults to a Windows
   * named pipe; tests substitute a Unix socket path.
   */
  readonly pipePath?: ((id: string) => string) | undefined;
  /**
   * Accepts a deferred host: `idle` announcement and authentication first,
   * `hello` and `ready` only after a later {@link ConPtyStartOp}.
   */
  readonly deferred?: boolean | undefined;
}

function defaultPipePath(id: string): string {
  return `${CONPTY_PIPE_PREFIX}${id}`;
}

function monotonicNowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

async function defaultControlDependencies(): Promise<ConPtyControlDependencies> {
  const [crypto2, net2] = await Promise.all([crypto, net]);
  return {
    createServer: (): Server => net2.createServer(),
    randomUUID: (): string => crypto2.randomUUID(),
  };
}

/**
 * Named-pipe control server for the ConPTY host.
 *
 * The server exists before the host spawns. The first connection must send a
 * hello line carrying the expected token; every other connection is closed.
 * Resizes requested before the host connects are coalesced, latest wins.
 */
export class WindowsNamedPipeControlChannel implements ConPtyControlChannel {
  public readonly path;
  public readonly token;
  public readonly hello;
  public readonly ready;
  /** Resolves when a deferred host has announced itself and been
   * authenticated. Never resolves on a non-deferred channel. */
  public readonly idleAuthenticated: Promise<void>;
  public onResized?: ((event: ConPtyResizedEvent) => void) | undefined;
  #socket: Socket | null = null;
  #pending: ConPtyResizeOp | null = null;
  #disposed = false;
  /** Accepted connections that have not closed yet. `dispose()` destroys
   * them: `server.close()` waits for every accepted connection, so one
   * silent foreign pre-hello connection would wedge pane close forever. */
  readonly #candidates = new Set<Socket>();
  readonly #connection;
  readonly #settleHello;
  readonly #settleReady;
  readonly #settleIdleAuth;
  readonly #deferred: boolean;
  readonly #readyTimeoutMs: number;
  #idleAuthed = false;
  #readyDeadline: number | undefined = void 0;
  #exitCode: number | null = null;

  readonly #server: Server;

  private constructor(
    path: string,
    token: string,
    server: Server,
    readyTimeoutMs: number,
    deferred = false,
  ) {
    this.path = path;
    this.token = token;
    this.#server = server;
    this.#deferred = deferred;
    this.#readyTimeoutMs = readyTimeoutMs;
    const connection = promisePromise<Socket>(),
      hello = promisePromise<ConPtyHelloEvent>(),
      ready = promisePromise<ConPtyReadyEvent>(),
      idleAuth = promisePromise();
    this.#connection = connection.then(async ({ promise }) => promise);
    this.#connection.catch(noop satisfies () => unknown as () => unknown);
    this.hello = hello.then(async ({ promise }) => promise);
    this.hello.catch(noop satisfies () => unknown as () => unknown);
    this.ready = ready.then(async ({ promise }) => promise);
    this.ready.catch(noop satisfies () => unknown as () => unknown);
    this.idleAuthenticated = idleAuth.then(async ({ promise }) => promise);
    this.idleAuthenticated.catch(noop satisfies () => unknown as () => unknown);
    this.#settleHello = hello;
    this.#settleReady = ready;
    this.#settleIdleAuth = idleAuth;
    server.on("connection", (candidate) => {
      this.#accept(candidate);
    });
    server.once("error", (error) => {
      this.#fail(new ConPtyControlError("aborted", String(error)));
    });
    this.ready.then(
      async () => {
        const socket = this.#socket,
          { resolve, reject } = await connection;
        if (socket) {
          resolve(socket);
          return;
        }
        reject(new ConPtyControlError("aborted"));
      },
      async (error: unknown) => {
        (await connection).reject(error);
      },
    );
    // The deadline bounds the current handshake phase: spawn to ready on an
    // immediate channel, spawn to idle authentication on a deferred one.
    this.#armDeadline();
  }

  #armDeadline(): void {
    if (this.#readyDeadline !== void 0) self.clearTimeout(this.#readyDeadline);
    this.#readyDeadline = self.setTimeout(() => {
      this.#disposed = true;
      this.#socket?.destroy();
      if (this.#server.listening) this.#server.close();
      this.#fail(
        new ConPtyControlError(
          "timeout",
          "The ConPTY host did not complete the ready handshake.",
        ),
      );
    }, this.#readyTimeoutMs);
  }

  /** Starts one session on an authenticated deferred host. */
  public async start(op: ConPtyStartOp): Promise<void> {
    const socket = this.#socket;
    if (!this.#deferred) {
      throw new Error("Only a deferred control channel can start a session.");
    }
    if (!this.#idleAuthed || !socket || socket.destroyed) {
      throw new ConPtyControlError(
        "aborted",
        "The deferred host is not authenticated.",
      );
    }
    this.#armDeadline();
    await writePromise(socket, encodeConPtyOp(op));
  }

  public static async create(
    dependencies?: ConPtyControlDependencies,
  ): Promise<WindowsNamedPipeControlChannel> {
    const dependencies0 = dependencies ?? (await defaultControlDependencies()),
      path = (dependencies0.pipePath ?? defaultPipePath)(
        dependencies0.randomUUID(),
      ),
      /*
       * The token stops blind or accidental connections to a guessed pipe
       * name. The pipe's default DACL makes the same Windows user the trust
       * boundary; this is not isolation from hostile same-user code.
       */
      token = dependencies0.randomUUID(),
      readyTimeoutMs = dependencies0.readyTimeoutMs ?? CONPTY_READY_TIMEOUT_MS;
    if (!isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
      throw new RangeError("The ConPTY ready timeout must be positive.");
    }
    const server = dependencies0.createServer(),
      ret = new WindowsNamedPipeControlChannel(
        path,
        token,
        server,
        readyTimeoutMs,
        dependencies0.deferred ?? false,
      );
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            server.removeListener("listening", onListening);
            reject(error);
          },
          onListening = (): void => {
            server.removeListener("error", onError);
            resolve();
          };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(path);
      });
    } catch (error) {
      await ret.dispose();
      throw error;
    }
    return ret;
  }

  public reportedExitCode(): number | null {
    return this.#exitCode;
  }

  public async resize(
    columns: number,
    rows: number,
    seq?: number,
  ): Promise<void> {
    this.#pending = {
      columns,
      op: "resize",
      rows,
      ...(seq === void 0 ? {} : { seq }),
    };
    await this.#flush(await this.#connection);
  }

  public async kill(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      return;
    }
    await writePromise(socket, encodeConPtyOp({ op: "kill" }));
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    self.clearTimeout(this.#readyDeadline);
    this.#fail(new ConPtyControlError("aborted"));
    this.#socket?.destroy();
    this.#socket = null;
    for (const candidate of this.#candidates) {
      candidate.destroy();
    }
    this.#candidates.clear();
    if (this.#server.listening) {
      await new Promise<void>((resolve) => {
        this.#server.close(() => {
          resolve();
        });
      });
    }
  }

  #accept(candidate: Socket): void {
    if (this.#disposed || this.#socket !== null) {
      candidate.destroy();
      return;
    }
    this.#candidates.add(candidate);
    let buffer: Buffer = Buffer.alloc(0),
      hello: ConPtyHelloEvent | null = null,
      idle = !this.#deferred,
      ready = false;
    const reject = (error: ConPtyControlError): void => {
        candidate.destroy();
        // Only the channel's own connection may fail the handshake: a
        // stray pipe prober must not poison it for the real host.
        if (this.#socket === candidate) this.#fail(error);
      },
      sendAuthenticate = (onAuthenticated?: () => void): void => {
        writePromise(
          candidate,
          encodeConPtyOp({ op: "authenticate", token: this.token }),
        ).then(onAuthenticated, (error: unknown) => {
          reject(
            new ConPtyControlError(
              "aborted",
              `Could not authenticate the ConPTY host: ${String(error)}`,
            ),
          );
        });
      },
      onData = (chunk: Buffer | string): void => {
        const { lines, overflow, rest } = splitConPtyLines(
          buffer,
          typeof chunk === "string"
            ? Buffer.from(chunk, DEFAULT_ENCODING)
            : chunk,
        );
        buffer = rest;
        if (overflow) {
          reject(new ConPtyControlError("unauthenticated", "line too long"));
          return;
        }
        for (const line of lines) {
          const event = parseConPtyHostEvent(line);
          if (!idle) {
            if (
              !event ||
              event.event !== "idle" ||
              event.token !== this.token ||
              this.#socket !== null
            ) {
              reject(new ConPtyControlError("unauthenticated"));
              return;
            }
            idle = true;
            this.#socket = candidate;
            // Stop accepting: exactly one host owns the channel.
            this.#server.close();
            if (this.#readyDeadline !== void 0) {
              self.clearTimeout(this.#readyDeadline);
              this.#readyDeadline = void 0;
            }
            sendAuthenticate(() => {
              this.#succeedIdleAuth();
            });
            continue;
          }
          if (!hello) {
            if (
              !event ||
              event.event !== "hello" ||
              event.token !== this.token ||
              (this.#socket !== null && this.#socket !== candidate)
            ) {
              reject(new ConPtyControlError("unauthenticated"));
              return;
            }
            hello = event;
            this.#socket = candidate;
            this.#server.close();
            this.#succeedHello(event);
            if (!this.#deferred) {
              sendAuthenticate();
            }
            continue;
          }
          if (!ready) {
            if (
              !event ||
              event.event !== "ready" ||
              event.hostPid !== hello.hostPid ||
              event.childPid !== hello.childPid
            ) {
              reject(
                new ConPtyControlError(
                  "protocol",
                  "The ConPTY host returned an invalid ready attestation.",
                ),
              );
              return;
            }
            ready = true;
            self.clearTimeout(this.#readyDeadline);
            this.#readyDeadline = void 0;
            this.#succeedReady(event);
            this.#flush(candidate).catch((error: unknown) => {
              /* @__PURE__ */ self.console.debug(error);
            });
            continue;
          }
          if (event?.event === "exit") {
            this.#exitCode = event.code;
          } else if (event?.event === "resized") {
            try {
              this.onResized?.(event);
            } catch (error) {
              /* @__PURE__ */ self.console.debug(error);
            }
          }
        }
      };
    candidate.on("data", onData);
    // Only the owning socket fails the handshake. dispose() sets disposed
    // before destroying it, so a close/error while not disposed is the host
    // dying ("disconnected"), not the user leaving ("aborted"); the circuit
    // breaker ignores aborts.
    candidate.once("error", (error) => {
      /* @__PURE__ */ self.console.debug(error);
      if (!ready && this.#socket === candidate)
        this.#fail(
          new ConPtyControlError(
            this.#disposed ? "aborted" : "disconnected",
            String(error),
          ),
        );
      candidate.destroy();
    });
    candidate.once("close", () => {
      this.#candidates.delete(candidate);
      if (!ready && this.#socket === candidate)
        this.#fail(
          new ConPtyControlError(
            this.#disposed ? "aborted" : "disconnected",
            "The ConPTY control channel closed before readiness.",
          ),
        );
    });
  }

  async #flush(socket: Socket): Promise<void> {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || socket.destroyed) {
      return;
    }
    await writePromise(socket, encodeConPtyOp(pending));
  }

  #succeedIdleAuth(): void {
    this.#idleAuthed = true;
    this.#settleIdleAuth
      .then(({ resolve }) => {
        resolve();
      })
      .catch(noop satisfies () => unknown as () => unknown);
  }

  #succeedHello(hello: ConPtyHelloEvent): void {
    this.#settleHello
      .then(({ resolve }) => {
        resolve(hello);
      })
      .catch(noop satisfies () => unknown as () => unknown);
  }

  #succeedReady(ready: ConPtyReadyEvent): void {
    this.#settleReady
      .then(({ resolve }) => {
        resolve(ready);
      })
      .catch(noop satisfies () => unknown as () => unknown);
  }

  #fail(error: ConPtyControlError): void {
    for (const settle of [
      this.#settleHello,
      this.#settleReady,
      this.#settleIdleAuth,
    ]) {
      settle
        .then(({ reject }) => {
          reject(error);
        })
        .catch(noop satisfies () => unknown as () => unknown);
    }
  }
}

export interface ConPtySpawnOptions {
  readonly cwd?: URL | string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface ConPtyPseudoterminalDependencies {
  readonly createControl: () => Promise<ConPtyControlChannel>;
  /**
   * Writes the host source to a temporary file and returns its path. The host
   * cannot be passed through `python -c`: the source exceeds the 32767
   * character Windows command-line limit.
   */
  readonly materializeSource: (source: string) => Promise<string>;
  readonly source: PromiseLike<string>;
  readonly spawn: (
    executable: string,
    args: readonly string[],
    options: ConPtySpawnOptions,
  ) => Promise<PipedChildProcess>;
  /** Creates a control channel that accepts a deferred (idle) host. */
  readonly createDeferredControl?:
    (() => Promise<WindowsNamedPipeControlChannel>) | undefined;
  /** Spare hosts, keyed by Python executable. */
  readonly pool?: ConPtyHostPool | undefined;
}

/** Longest encoded `start` op sent to a deferred host, in UTF-8 bytes. The
 * host's NDJSON decoder drops longer lines, so an oversized session
 * cold-spawns instead. Kept under the host's 64 KiB cap
 * (`_MAX_CONTROL_LINE_BYTES`). */
const CONPTY_MAX_START_LINE = 49_152;

export interface ConPtySpareHost {
  readonly control: WindowsNamedPipeControlChannel;
  readonly host: PipedChildProcess;
  /** Pool generation the host was acquired from. {@link ConPtyHostPool.release}
   * kills a host from a retired generation instead of re-pooling it. */
  readonly generation: number;
}

interface ConPtySpareEntry {
  readonly control: WindowsNamedPipeControlChannel;
  readonly host: PipedChildProcess;
  /** Set once the spare has completed token authentication. */
  authenticated: boolean;
  /** Exit listener to detach on acquire, when ownership leaves the pool. */
  readonly evict: () => void;
}

/**
 * Keeps one authenticated idle ConPTY host per Python executable.
 *
 * Interpreter startup dominates the ConPTY spawn stage. A spare host boots in
 * the background after each terminal open, so the next open pays only Win32
 * session creation plus the ready handshake. A spare that has not finished
 * authenticating is left alone; the caller cold-spawns instead.
 */
export class ConPtyHostPool {
  readonly #spares = new Map<string, ConPtySpareEntry>();
  /** Interpreters whose spare is still booting, by generation. */
  readonly #booting = new Map<string, number>();
  #disposed = false;
  /** Bumped by {@link clear}: a boot in flight across a bump stands down, and
   * a second `ensureSpare` within one generation does not boot a duplicate. */
  #generation = 0;

  public acquire(pythonExecutable: string): ConPtySpareHost | null {
    const entry = this.#spares.get(pythonExecutable);
    if (!entry?.authenticated) {
      return null;
    }
    this.#spares.delete(pythonExecutable);
    /*
     * Ownership moves to the caller: the pool's evict must not dispose a
     * control channel it no longer owns — destroying the socket could
     * discard the host's buffered final exit report.
     */
    entry.host.off("exit", entry.evict);
    if (!isRunning(entry.host)) {
      entry.control.dispose().catch((error: unknown) => {
        /* @__PURE__ */ self.console.debug(error);
      });
      return null;
    }
    return {
      control: entry.control,
      generation: this.#generation,
      host: entry.host,
    };
  }

  /**
   * Takes back a spare the caller acquired but never started, so the next
   * open still finds a booted spare. Only a healthy host from the current
   * generation re-pools; anything else is killed, because the user may have
   * opted out while the caller held it.
   */
  public release(pythonExecutable: string, warm: ConPtySpareHost): void {
    const { control, generation, host } = warm;
    if (
      !this.#disposed &&
      generation === this.#generation &&
      !this.#spares.has(pythonExecutable) &&
      isRunning(host)
    ) {
      // The host authenticated before it was acquired.
      this.#insertSpare(pythonExecutable, control, host, true);
      return;
    }
    if (isRunning(host)) {
      host.kill();
    }
    control.dispose().catch((error: unknown) => {
      /* @__PURE__ */ self.console.debug(error);
    });
  }

  /** Registers one spare and its eviction wiring. */
  #insertSpare(
    pythonExecutable: string,
    control: WindowsNamedPipeControlChannel,
    host: PipedChildProcess,
    authenticated: boolean,
  ): ConPtySpareEntry {
    const evict = (): void => {
      if (this.#spares.get(pythonExecutable) === entry) {
        this.#spares.delete(pythonExecutable);
      }
      control.dispose().catch((error: unknown) => {
        /* @__PURE__ */ self.console.debug(error);
      });
    };
    const entry: ConPtySpareEntry = { authenticated, control, evict, host };
    this.#spares.set(pythonExecutable, entry);
    host.once("exit", evict);
    return entry;
  }

  public ensureSpare(
    pythonExecutable: string,
    dependencies: ConPtyPseudoterminalDependencies,
  ): void {
    const generation = this.#generation;
    if (
      this.#disposed ||
      this.#spares.has(pythonExecutable) ||
      this.#booting.get(pythonExecutable) === generation
    ) {
      return;
    }
    const { createDeferredControl } = dependencies;
    if (!createDeferredControl) {
      return;
    }
    this.#booting.set(pythonExecutable, generation);
    void (async (): Promise<void> => {
      const control = await createDeferredControl();
      let host;
      try {
        // The channel owns a listening server and an armed ready-deadline
        // timer, so every pre-adoption failure — source materialization
        // included, not just the spawn — must dispose it.
        const sourceFile = await dependencies.materializeSource(
          await dependencies.source,
        );
        host = await dependencies.spawn(
          pythonExecutable,
          [...CONPTY_PYTHON_FLAGS, sourceFile, "--defer-session", control.path],
          {
            env: await applyEnv({
              profile: [[CONPTY_TOKEN_ENVIRONMENT_VARIABLE, control.token]],
            }),
          },
        );
      } catch (error) {
        await control.dispose();
        throw error;
      }
      if (
        this.#disposed ||
        this.#generation !== generation ||
        this.#spares.has(pythonExecutable)
      ) {
        host.kill();
        await control.dispose();
        return;
      }
      const entry = this.#insertSpare(pythonExecutable, control, host, false);
      control.idleAuthenticated.then(
        () => {
          entry.authenticated = true;
        },
        () => {
          entry.evict();
          if (isRunning(host)) host.kill();
        },
      );
      logChildStderr(host);
    })()
      .catch((error: unknown) => {
        /* @__PURE__ */ self.console.debug(error);
      })
      .finally(() => {
        if (this.#booting.get(pythonExecutable) === generation)
          this.#booting.delete(pythonExecutable);
      });
  }

  /** Kills every spare without retiring the pool, so a later
   * {@link ensureSpare} can refill it. Used when the user opts out. */
  public clear(): void {
    this.#generation += 1;
    for (const [key, entry] of [...this.#spares]) {
      this.#spares.delete(key);
      if (isRunning(entry.host)) {
        entry.host.kill();
      }
      entry.control.dispose().catch((error: unknown) => {
        /* @__PURE__ */ self.console.debug(error);
      });
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.clear();
  }
}

/** Module-level by design: Obsidian re-evaluates `main.js` on every enable,
 * so a pool disposed at unload never outlives its plugin instance. */
export const CONPTY_HOST_POOL = new ConPtyHostPool();

/** Plugins whose unload already disposes {@link CONPTY_HOST_POOL} spares. */
const poolDisposalRegistered = new WeakSet<TerminalPlugin>();

/** Ties the pool's spare hosts to the plugin lifetime, once per plugin. */
export function registerConPtyPoolDisposal(
  context: TerminalPlugin,
  pool: ConPtyHostPool,
): void {
  if (poolDisposalRegistered.has(context)) return;
  poolDisposalRegistered.add(context);
  try {
    context.register(() => {
      pool.dispose();
    });
  } catch (error) {
    self.console.warn(error);
  }
}

const materializedConPtySources = new Map<string, Promise<string>>();

/**
 * Interpreter flags for the ConPTY host spawn.
 *
 * `-I` (isolated: no user site, no `PYTHON*` env) plus `-S` (no `site`
 * import) and `-B` (no bytecode writes) cut interpreter startup. The host is
 * pure standard library, and the child's environment block is unaffected.
 */
const CONPTY_PYTHON_FLAGS = deepFreeze(["-I", "-S", "-B"]);

export const CONPTY_DEPENDENCIES: ConPtyPseudoterminalDependencies = {
  createControl: async () => WindowsNamedPipeControlChannel.create(),
  createDeferredControl: async () =>
    WindowsNamedPipeControlChannel.create({
      ...(await defaultControlDependencies()),
      deferred: true,
    }),
  async materializeSource(source) {
    /*
     * The host source lives at a stable, content-addressed path and is
     * verified once per session. A fresh random temp file per spawn defeated
     * the antivirus per-file scan cache: both the write and python.exe's open
     * were rescanned on every terminal open.
     */
    let pending = materializedConPtySources.get(source);
    if (pending) {
      // A temp cleaner may remove the file mid-session; a spawn against a
      // missing file would read as a broken runtime. Check cheaply first.
      const [verified, fsPromises2] = await Promise.all([pending, fsPromises]),
        present = await fsPromises2.access(verified).then(
          () => true,
          () => false,
        );
      if (!present) {
        materializedConPtySources.delete(source);
        pending = void 0;
      }
    }
    if (!pending) {
      pending = (async (): Promise<string> => {
        const [crypto2, fsPromises2, os2, path2] = await Promise.all([
            crypto,
            fsPromises,
            os,
            path,
          ]),
          digest = crypto2
            .createHash("sha256")
            .update(source, "utf8")
            .digest("hex")
            .slice(0, 16),
          target = path2.join(
            os2.tmpdir(),
            `obsidian-terminal-conpty-${digest}.py`,
          ),
          existing = await fsPromises2
            .readFile(target, { encoding: DEFAULT_ENCODING })
            .catch(() => null);
        if (existing !== source) {
          const staging = `${target}.${String(process.pid)}.tmp`;
          await fsPromises2.writeFile(staging, source, {
            encoding: DEFAULT_ENCODING,
            flag: "w",
          });
          await fsPromises2.rename(staging, target);
        }
        // The stable file is reused by later sessions; never delete it.
        return target;
      })();
      materializedConPtySources.set(source, pending);
      pending.catch(() => materializedConPtySources.delete(source));
    }
    return pending;
  },
  pool: CONPTY_HOST_POOL,
  source: win32ConPtyPy,
  async spawn(executable, args, options) {
    const childProcess2 = await childProcess;
    return spawnPromise(async () =>
      childProcess2.spawn(executable, [...args], {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  },
};

/**
 * ConPTY-backed Windows pseudoterminal.
 *
 * The Python host owns the ConPTY session. Terminal bytes flow over the host's
 * stdin and stdout; resizes and kills flow over a named-pipe control channel
 * that this process serves. The host's exit code is the child's exit code, so
 * no temporary file is needed to recover it.
 */
export class ConPtyPseudoterminal implements Pseudoterminal {
  public readonly shell;
  public readonly onExit;
  protected readonly control;
  protected readonly host;
  readonly #dispose;
  #ready = false;
  #resizeSeq = 0;
  /** Open while conhost's post-resize repaint frames may still arrive.
   * Chunks inside the window bypass write slicing (see
   * {@link pipeShellToTerminal}). */
  readonly #repaintWindow = createResizeRepaintWindow(
    TERMINAL_CONPTY_RESIZE_REPAINT_WINDOW,
  );

  public constructor(
    protected readonly context: TerminalPlugin,
    {
      args,
      columns,
      cwd,
      environment,
      executable,
      pythonExecutable,
      rows,
    }: ShellPseudoterminalArguments,
    dependencies: ConPtyPseudoterminalDependencies = CONPTY_DEPENDENCIES,
  ) {
    const { language, settings } = context,
      pool = dependencies.pool,
      warm = pythonExecutable
        ? (pool?.acquire(pythonExecutable) ?? null)
        : null;
    const spawnColdHost = async (
        interpreter: string,
      ): Promise<{
        readonly control: ConPtyControlChannel;
        readonly host: PipedChildProcess;
      }> => {
        const control0 = await dependencies.createControl();
        try {
          // Source materialization and applyEnv (reg query x2 on first use)
          // run concurrently.
          const [sourceFile, env] = await Promise.all([
              dependencies.source.then(async (source) =>
                dependencies.materializeSource(source),
              ),
              applyEnv({
                profile: [
                  ...(environment ?? []),
                  [CONPTY_TOKEN_ENVIRONMENT_VARIABLE, control0.token],
                ],
              }),
            ]),
            ret = await dependencies.spawn(
              interpreter,
              [
                ...CONPTY_PYTHON_FLAGS,
                sourceFile,
                normalizeConPtyDimension(
                  columns,
                  CONPTY_DEFAULT_COLUMNS,
                ).toString(),
                normalizeConPtyDimension(rows, CONPTY_DEFAULT_ROWS).toString(),
                control0.path,
                "--",
                executable,
                ...(args ?? []),
              ],
              { cwd, env },
            );
          logChildStderr(ret);
          return { control: control0, host: ret };
        } catch (error) {
          // Nothing else owns this channel yet; do not leak its server.
          await control0.dispose().catch((error0: unknown) => {
            self.console.warn(error0);
          });
          throw error;
        }
      },
      startWarmHost = async (
        warm0: ConPtySpareHost,
      ): Promise<
        | {
            readonly control: ConPtyControlChannel;
            readonly host: PipedChildProcess;
          }
        | "declined"
        | null
      > => {
        try {
          const [env, url2] = await Promise.all([
              applyEnv({ profile: environment ?? [] }),
              url,
            ]),
            envRecord: Record<string, string> = {};
          for (const [key, value] of Object.entries(env)) {
            if (typeof value === "string") envRecord[key] = value;
          }
          const startOp: ConPtyStartOp = {
              columns: normalizeConPtyDimension(
                columns,
                CONPTY_DEFAULT_COLUMNS,
              ),
              command: [executable, ...(args ?? [])],
              cwd:
                cwd === void 0
                  ? null
                  : typeof cwd === "string"
                    ? cwd
                    : url2.fileURLToPath(cwd),
              env: envRecord,
              op: "start",
              rows: normalizeConPtyDimension(rows, CONPTY_DEFAULT_ROWS),
            },
            encoded = encodeConPtyOp(startOp);
          if (Buffer.byteLength(encoded, "utf8") > CONPTY_MAX_START_LINE) {
            // The host's decoder would drop the line; cold-spawn instead. The
            // host counts UTF-8 bytes, so a string length would let a
            // non-ASCII environment past this guard and hang the start op.
            return "declined";
          }
          await warm0.control.start(startOp);
          return { control: warm0.control, host: warm0.host };
        } catch (error) {
          /* @__PURE__ */ self.console.debug(error);
          return null;
        }
      },
      session = (async (): Promise<{
        readonly control: ConPtyControlChannel;
        readonly host: PipedChildProcess;
      }> => {
        if (!pythonExecutable) {
          throw new Error(
            language.value.t("errors.no-Python-to-spawn-Windows-ConPTY"),
          );
        }
        if (warm) {
          const started = await startWarmHost(warm);
          if (started === "declined") {
            pool?.release(pythonExecutable, warm);
          } else if (started) {
            return started;
          } else {
            if (isRunning(warm.host)) {
              warm.host.kill();
            }
            await warm.control.dispose().catch((error: unknown) => {
              self.console.warn(error);
            });
          }
        }
        return spawnColdHost(pythonExecutable);
      })(),
      control: Promise<ConPtyControlChannel> = session.then(
        (session0) => session0.control,
      );
    control.catch(noop satisfies () => unknown as () => unknown);
    if (pool) registerConPtyPoolDisposal(context, pool);
    this.control = control;
    control
      .then((control0) => {
        control0.onResized = (): void => {
          // The acknowledgment marks the host apply; conhost's repaint
          // frames follow it, so keep the unsliced window open from here.
          this.#repaintWindow.arm();
        };
      })
      .catch(noop satisfies () => unknown as () => unknown);
    let disposing: Promise<void> | null = null;
    const dispose = (): Promise<void> => {
      disposing ??= (async (): Promise<void> => {
        try {
          await (await control).dispose();
        } catch (error) {
          self.console.warn(error);
        }
      })();
      return disposing;
    };
    this.#dispose = dispose;
    const host = session.then((session0) => session0.host);
    host.catch(noop satisfies () => unknown as () => unknown);
    this.host = host;
    const hostExit = host.then(
      async (shell) =>
        new Promise<NodeJS.Signals | number>((resolve) => {
          if (!isRunning(shell)) {
            resolve(shell.exitCode ?? shell.signalCode ?? NaN);
            return;
          }
          shell.once("exit", (code, signal) => {
            resolve(code ?? signal ?? NaN);
          });
        }),
    );
    this.onExit = hostExit
      .then(async (exit) => (await control).reportedExitCode() ?? exit)
      .finally(dispose);
    this.onExit.catch(noop satisfies () => unknown as () => unknown);
    this.shell = (async (): Promise<PipedChildProcess> => {
      try {
        const [shell, control0] = await Promise.all([host, control]),
          ready = await Promise.race([
            control0.ready,
            hostExit.then(() => {
              throw new Error(
                language.value.t("errors.conpty-host-exited-before-ready"),
              );
            }),
          ]);
        if (!isProcessId(shell.pid) || ready.hostPid !== shell.pid) {
          throw new ConPtyControlError(
            "protocol",
            "The ConPTY ready host PID does not match the spawned host.",
          );
        }
        if (!isRunning(shell)) {
          throw new Error(
            language.value.t("errors.conpty-host-exited-before-ready"),
          );
        }
        this.#ready = true;
        return shell;
      } catch (error) {
        const shell = await host.catch(() => null),
          // An abort is the user closing the pane mid-boot, not a failure
          // worth a notice.
          failure =
            error instanceof ConPtyControlError && error.reason !== "aborted"
              ? error
              : null,
          // A host that dies reports its own exit code and the disconnect
          // is only its symptom, so give the exit event a moment to arrive
          // before blaming the handshake.
          hostReportedExit =
            failure?.reason === "disconnected" &&
            (await Promise.race([
              hostExit.then(
                (code) => typeof code === "number",
                () => false,
              ),
              sleep2(self, TERMINAL_CONPTY_HOST_EXIT_WAIT).then(() => false),
            ]));
        if (shell && isRunning(shell)) shell.kill();
        await dispose();
        if (failure && !hostReportedExit) {
          notice2(
            () =>
              language.value.t(
                failure.reason === "timeout"
                  ? "errors.conpty-readiness-timeout"
                  : "errors.conpty-control-unauthenticated",
              ),
            settings.value.errorNoticeTimeout,
            context,
          );
        }
        throw error;
      }
    })();
    /*
     * `pipe()` gates on the host process only, so nothing is guaranteed to
     * await `shell`. A readiness failure still surfaces through the notice
     * and the host exit above.
     */
    this.shell.catch(noop satisfies () => unknown as () => unknown);
    // Spare only after ready: earlier competes for CPU, after a failure
    // respawns a broken interpreter.
    this.shell
      .then(() => {
        if (settings.value.prewarmConPty && pythonExecutable)
          pool?.ensureSpare(pythonExecutable, dependencies);
      })
      .catch(noop satisfies () => unknown as () => unknown);
  }

  public async kill(): Promise<void> {
    const [shell, control] = await Promise.all([this.host, this.control]);
    if (!this.#ready) {
      if (isRunning(shell) && !shell.kill()) {
        await this.#dispose();
        throw new Error(
          this.context.language.value.t("errors.error-killing-pseudoterminal"),
        );
      }
      await this.#dispose();
      return;
    }
    try {
      await control.kill();
    } catch (error) {
      self.console.warn(error);
    }
    const exited = await Promise.race([
      this.onExit.then(
        () => true,
        () => true,
      ),
      sleep2(self, TERMINAL_EXIT_CLEANUP_WAIT).then(() => false),
    ]);
    if (exited) {
      return;
    }
    if (!shell.kill()) {
      await this.#dispose();
      throw new Error(
        this.context.language.value.t("errors.error-killing-pseudoterminal"),
      );
    }
  }

  public async resize(columns: number, rows: number): Promise<void> {
    const seq = ++this.#resizeSeq;
    this.#repaintWindow.arm();
    await (
      await this.control
    ).resize(
      normalizeConPtyDimension(columns, CONPTY_DEFAULT_COLUMNS),
      normalizeConPtyDimension(rows, CONPTY_DEFAULT_ROWS),
      seq,
    );
    // Re-arm after the send: the host applies the resize and conhost emits
    // the repaint only after this write reaches the control pipe.
    this.#repaintWindow.arm();
  }

  public async pipe(terminal: Terminal): Promise<void> {
    // Gate on the host process, not readiness: nothing arrives before the
    // host resumes the child.
    const shell = await this.host;
    await pipeShellToTerminal(terminal, shell, [shell.stdout], this.onExit, {
      repaintWindow: this.#repaintWindow,
    });
  }
}

/** Picks the Windows pseudoterminal implementation for a profile backend. */
export function selectWin32Pseudoterminal(
  backend: ShellPseudoterminalArguments["win32Backend"],
): typeof ConPtyPseudoterminal | typeof WindowsPseudoterminal {
  return backend === "conpty" ? ConPtyPseudoterminal : WindowsPseudoterminal;
}

/**
 * Dispatches to the backend named by `win32Backend`. The settings fixer
 * always supplies one; a missing argument only happens for hand-built
 * profiles and reads as ConHost, which runs without Python.
 */
class Win32Pseudoterminal implements Pseudoterminal {
  public readonly shell;
  public readonly onExit;
  protected readonly delegate;

  public constructor(
    context: TerminalPlugin,
    args: ShellPseudoterminalArguments,
  ) {
    const Backend = selectWin32Pseudoterminal(args.win32Backend),
      delegate = new Backend(context, args);
    this.delegate = delegate;
    this.shell = delegate.shell;
    this.onExit = delegate.onExit;
  }

  public kill(): AsyncOrSync<void> {
    return this.delegate.kill();
  }

  public pipe(terminal: Terminal): AsyncOrSync<void> {
    return this.delegate.pipe(terminal);
  }

  public resize(columns: number, rows: number): AsyncOrSync<void> {
    return this.delegate.resize(columns, rows);
  }
}

export namespace Pseudoterminal {
  export const PLATFORM_PSEUDOTERMINALS = deepFreeze({
    darwin: UnixPseudoterminal,
    linux: UnixPseudoterminal,
    win32: Win32Pseudoterminal,
  });
  export type SupportedPlatforms = readonly ["darwin", "linux", "win32"];
  export const SUPPORTED_PLATFORMS = typedKeys<SupportedPlatforms>()(
    PLATFORM_PSEUDOTERMINALS,
  );
  export const PLATFORM_PSEUDOTERMINAL = inSet(
    SUPPORTED_PLATFORMS,
    Platform.CURRENT,
  )
    ? PLATFORM_PSEUDOTERMINALS[deopaque(Platform.CURRENT)]
    : null;
}
