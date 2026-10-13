import {
  Functions,
  Platform,
  type PluginContext,
  activeSelf,
  consumeEvent,
  deepFreeze,
  deopaque,
  dynamicRequire,
  instanceOf,
  isNonNil,
  notice2,
  revealPrivateFilter,
} from "@polyipseity/obsidian-plugin-library";
import type { CanvasAddon } from "@xterm/addon-canvas";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ILink, ITerminalAddon, ITheme, Terminal } from "@xterm/xterm";
import { eastAsianWidth } from "get-east-asian-width";
import { around } from "monkey-around";
import { FileSystemAdapter, Platform as ObsidianPlatform } from "obsidian";
import { type AsyncOrSync, noop } from "ts-essentials";
import { BUNDLE } from "../imports.js";
import { DOMClasses2 } from "../magic.js";
import type { Settings } from "../settings-data.js";
import type { $App } from "../@types/obsidian.js";
import {
  type DroppedPathOptions,
  type DroppedPaths,
  type ShellGrammar,
  droppedPathPastes,
  formatDroppedPath,
  formatDroppedPaths,
  lineByteLimit,
  shellGrammar,
  uriListPaths,
  vaultDragPaths,
  wslDistribution,
} from "./dropped-paths.js";
import { Win32InputMode, isWin32ClipboardChord } from "./win32-input-mode.js";

const electron = dynamicRequire<typeof import("electron")>(BUNDLE, "electron"),
  fsPromises = dynamicRequire<typeof import("node:fs/promises")>(
    BUNDLE,
    "node:fs/promises",
  );
// Prevent unhandled rejections from `dynamicRequire` in tests.
/* @__PURE__ */ electron.catch(noop);
/* @__PURE__ */ fsPromises.catch(noop);

// How many paths of dropped URI lists are looked up on disk at a time, over
// every drop on every terminal. What counts is a `stat` that has not answered,
// also when its drop no longer waits for it: it holds a thread of the pool the
// process reads its files with, and a volume that never answers keeps it.
// That pool has four threads, which Obsidian reads and saves notes with, so
// the lookups take half of it at most.
const LOOKUPS = 2,
  // The lookups in line for a slot, oldest first; each is called when a slot
  // is handed to it.
  lookupQueue: (() => void)[] = [];
// The slots taken.
let lookups = 0;

/**
 * Takes one of the {@link LOOKUPS} slots, waiting in line for one until
 * `deadline` settles.
 *
 * @returns whether a slot was taken, which `releaseLookup` then gives back.
 */
async function acquireLookup(deadline: Promise<unknown>): Promise<boolean> {
  if (lookups < LOOKUPS) {
    ++lookups;
    return true;
  }
  let grant: () => void = noop;
  const slot = new Promise<void>((resolve) => {
    grant = resolve;
  });
  lookupQueue.push(grant);
  await Promise.race([slot, deadline]);
  // `releaseLookup` takes the lookup it hands a slot to out of the line, so
  // one that is still in it has seen the deadline come first.
  const index = lookupQueue.indexOf(grant);
  if (index === -1) {
    return true;
  }
  lookupQueue.splice(index, 1);
  return false;
}

/** Gives a slot back: to the lookup that has waited longest, if one waits. */
function releaseLookup(): void {
  const next = lookupQueue.shift();
  if (next) {
    next();
  } else {
    --lookups;
  }
}

export class DisposerAddon extends Functions implements ITerminalAddon {
  public constructor(...args: readonly (() => void)[]) {
    super({ async: false, settled: true }, ...args);
  }

  public activate(_terminal: Terminal): void {
    // Noop
  }

  public dispose(): void {
    this.call();
  }
}

/** What a drop keeps of the moment it came, for when its paths are known. */
interface Drop {
  /** `DragAndDropAddon.#activation` at the drop, which says whose it is. */
  readonly activation: number;
  /** What had the focus in the terminal's window. */
  readonly focused: Element | null;
  /** `DragAndDropAddon.#input` at the drop, which says what was typed since. */
  readonly input: number;
  readonly terminal: Terminal;
}

/**
 * Inserts the paths of what is dropped onto the terminal: files and folders
 * dragged out of the vault, files dragged in from other applications, and
 * lists of file URIs. Every other drag is left to Obsidian.
 */
export class DragAndDropAddon implements ITerminalAddon {
  // Values of `DataTransfer.effectAllowed` that let a drop be a copy.
  static readonly #COPY_EFFECTS: ReadonlySet<string> = new Set([
    "all",
    "copy",
    "copyLink",
    "copyMove",
    "uninitialized",
  ]);

  // Values that let it be a link, but not a copy.
  static readonly #LINK_EFFECTS: ReadonlySet<string> = new Set([
    "link",
    "linkMove",
  ]);

  // Class Obsidian has on the body of its main window while it drags
  // something of its own, from wherever the drag started: a tab header once
  // the pointer has moved, and whatever its drag manager carries. A drag out
  // of another application never sets it.
  static readonly #GRABBING = "is-grabbing";

  // The standard type for a list of URIs. A source may put only the first of
  // several dragged files there: VS Code does.
  static readonly #URI_LIST = "text/uri-list";

  // VS Code's own type, in lower case as a data transfer lists its types. It
  // holds every dragged file and folder, and is the only type with a path on
  // the drag of an editor tab.
  static readonly #VSCODE_URI_LIST = "application/vnd.code.uri-list";

  // How long a drop waits for the paths of a URI list to be looked up on
  // disk, in milliseconds.
  static readonly #LOOKUP_DEADLINE = 2000;

  // What the terminal tells a program that asked for it when it gains or
  // loses the focus. It is data of the terminal like what is typed, but no
  // input of the user: a click on the terminal sets it off, and so does the
  // focus a drop gives it.
  static readonly #FOCUS_REPORTS: ReadonlySet<string> = new Set([
    "\u001b[I",
    "\u001b[O",
  ]);

  readonly #disposer = new Functions({ async: false, settled: true });
  // Set by `dispose()`: nothing would remove listeners added after it.
  #disposed = false;
  // Counts the calls of `activate()` and `dispose()`. What a drop has queued
  // is for the terminal it came in on, and is discarded once the count has
  // moved on: that terminal is replaced or gone.
  #activation = 0;
  // Settles when every drop so far is done with the terminal.
  #drops: Promise<void> = Promise.resolve();
  // Counts the input the terminal has sent to its program. A drop that had
  // to wait is not pasted once the count has moved on: the command line is
  // no longer the one the paths were dropped on.
  #input = 0;
  // Set while a drop is pasted, which the terminal sends as data as well.
  #pasting = false;

  /**
   * @param context - plugin whose vault, language and settings are used.
   * @param element - element of the terminal, which receives the drags.
   * @param profile - profile the terminal runs, which decides how paths are
   * written; `null` if unknown.
   * @param attached - gives a promise that is fulfilled once the terminal has
   * its program, which what is pasted then reaches, and rejected if it gets
   * none. It is asked at a drop, never before. Left out, the terminal is
   * taken to have its program from the start.
   */
  public constructor(
    protected readonly context: PluginContext,
    protected readonly element: HTMLElement,
    protected readonly profile: Settings.Profile | null = null,
    protected readonly attached: () => PromiseLike<unknown> = async () =>
      Promise.resolve(),
  ) {}

  /**
   * Tells whose drag this is from what every drag event can read; the data
   * itself is readable only in `drop`.
   *
   * @returns `vault` for a drag out of the vault, `native` for files from the
   * system, `uri` for a list of URIs, and `null` for a drag that is not for
   * the terminal (text selection, tab header...).
   */
  static #kind(
    event: DragEvent,
    draggable: unknown,
  ): "native" | "uri" | "vault" | null {
    if (isNonNil(draggable)) {
      return "vault";
    }
    // A drag Obsidian manages itself without a vault file in it is a tab on
    // its way to be docked. The types do not tell: a tab grabbed by an image
    // in its header (the icon of a web viewer) carries that image as a file
    // and a URI. The global `document` is read on purpose: the class is on
    // the body of the main window, also when the terminal is in a pop-out.
    if (document.body.classList.contains(DragAndDropAddon.#GRABBING)) {
      return null;
    }
    const types = event.dataTransfer?.types ?? [];
    if (types.includes("Files")) {
      return "native";
    }
    return types.includes(DragAndDropAddon.#VSCODE_URI_LIST) ||
      types.includes(DragAndDropAddon.#URI_LIST)
      ? "uri"
      : null;
  }

  /**
   * Picks the drop effect for a source, `none` refusing the drag. It is never
   * `move`: a file manager may delete the source after a move, and inserting
   * a path takes nothing away.
   */
  static #dropEffect(effectAllowed: string): "copy" | "link" | "none" {
    if (DragAndDropAddon.#COPY_EFFECTS.has(effectAllowed)) {
      return "copy";
    }
    return DragAndDropAddon.#LINK_EFFECTS.has(effectAllowed) ? "link" : "none";
  }

  /**
   * Returns the string a data transfer has for a type, which is readable only
   * while the drop is dispatched; `null` if the drag does not have that type.
   */
  static #data(dataTransfer: DataTransfer | null, type: string): string | null {
    return dataTransfer !== null && dataTransfer.types.includes(type)
      ? dataTransfer.getData(type)
      : null;
  }

  /** Narrows to a path that names something: a string that is not empty. */
  static #pathOrNull(path: unknown): string | null {
    return typeof path === "string" && path !== "" ? path : null;
  }

  public activate(terminal: Terminal): void {
    if (this.#disposed) {
      // Nothing would remove listeners added now.
      return;
    }
    // A second activation replaces the first, whose listeners would go on
    // pasting into the terminal they were added for.
    this.#removeListeners();
    const activation = ++this.#activation,
      { element } = this,
      over = (event: DragEvent): void => {
        this.#over(event);
      },
      leave = (event: DragEvent): void => {
        this.#leave(event);
      },
      drop = (event: DragEvent): void => {
        this.#drop(terminal, activation, event);
      },
      input = terminal.onData((data) => {
        if (!this.#pasting && !DragAndDropAddon.#FOCUS_REPORTS.has(data)) {
          ++this.#input;
        }
      });
    // The listeners are added in `activate` itself, with nothing awaited
    // before them: the terminal takes drags from the moment it shows. A drop
    // that comes before its program does is held (see `#hasProgram`).
    this.#disposer.push(
      () => {
        input.dispose();
      },
      () => {
        element.removeEventListener("dragenter", over);
      },
      () => {
        element.removeEventListener("dragover", over);
      },
      () => {
        element.removeEventListener("dragleave", leave);
      },
      () => {
        element.removeEventListener("drop", drop);
      },
    );
    element.addEventListener("drop", drop);
    element.addEventListener("dragleave", leave);
    element.addEventListener("dragover", over);
    element.addEventListener("dragenter", over);
  }

  public dispose(): void {
    this.#disposed = true;
    ++this.#activation;
    this.#removeListeners();
  }

  #removeListeners(): void {
    this.#disposer.call();
    // Emptied, so that listeners are not removed again at the next call.
    this.#disposer.length = 0;
  }

  /**
   * Tells whether a drop of that activation still has its terminal: neither
   * `activate()` nor `dispose()` has run since. Asked again wherever the
   * answer can have changed: a paste may dispose the addon.
   */
  #isCurrent(activation: number): boolean {
    return activation === this.#activation;
  }

  /**
   * Handles `dragenter` and `dragover`: accepting the drag there is what makes
   * the terminal a drop target. The event keeps propagating in every case,
   * because Obsidian moves its drag ghost from window-level `dragover`
   * listeners.
   */
  #over(event: DragEvent): void {
    if (event.defaultPrevented) {
      // Another handler has answered this drag.
      return;
    }
    const { dataTransfer } = event,
      draggable = this.#draggable(),
      kind = DragAndDropAddon.#kind(event, draggable);
    if (kind === null) {
      // Untouched, so that a tab can still be docked over the terminal.
      return;
    }
    // A vault drag without a path to insert (heading, unresolved link,
    // bookmark group...) is refused like a source that only allows a move.
    // So is one with no path that can be written for the shell (a name with
    // a tab or a newline): the cursor must not promise an insertion that the
    // drop then declines with a notice.
    const effect =
      kind === "vault" && !this.#canInsert(this.#vaultPaths(draggable).paths)
        ? "none"
        : DragAndDropAddon.#dropEffect(
            dataTransfer?.effectAllowed ?? "uninitialized",
          );
    // Refusing prevents the default as well: Obsidian's own handlers on the
    // view skip a prevented event, and would otherwise open the dragged file
    // in this tab when Shift (macOS) or Alt is held, replacing the terminal.
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = effect;
    }
    if (kind === "vault") {
      // A refused drag loses the label an earlier `dragover` gave it.
      this.#labelDragGhost(effect !== "none");
    }
  }

  /**
   * Handles `dragleave`: a vault drag that leaves the terminal loses the
   * label of its drag ghost. Obsidian does not clear the label in a pop-out
   * window, where it would stay on the ghost wherever the drag goes next.
   */
  #leave(event: DragEvent): void {
    const { relatedTarget } = event;
    if (
      instanceOf(relatedTarget, Node) &&
      this.element.contains(relatedTarget)
    ) {
      // The drag only moved from one part of the terminal to another.
      return;
    }
    if (isNonNil(this.#draggable())) {
      this.#labelDragGhost(false);
    }
  }

  #drop(terminal: Terminal, activation: number, event: DragEvent): void {
    if (event.defaultPrevented) {
      // Another handler took the drop.
      return;
    }
    const { dataTransfer } = event,
      // Obsidian clears the draggable in a timer right after the drop, and
      // the strings of a data transfer are readable only while the drop is
      // dispatched, so everything is read here, before anything is awaited.
      draggable = this.#draggable(),
      kind = DragAndDropAddon.#kind(event, draggable);
    if (kind === null) {
      // Left as it is: Obsidian docks a tab from window-level listeners.
      return;
    }
    // Keeps the browser from opening a dropped file or link, and Obsidian
    // from opening a vault file in this tab. The drop goes no further in any
    // case: the drag is the terminal's, also when it has no path to insert.
    event.preventDefault();
    event.stopPropagation();
    const drop: Drop = {
      activation,
      focused: this.element.ownerDocument.activeElement,
      input: this.#input,
      terminal,
    };
    if (kind === "vault") {
      // A vault drag never falls back on the other sources: what a browser
      // adds to it (the bitmap of a dragged image) is not what was dragged.
      const dropped = this.#vaultPaths(draggable);
      this.#afterEarlierDrops(() => {
        this.#insert(drop, dropped);
      });
      return;
    }
    const files = Array.from(dataTransfer?.files ?? []),
      vscodeUriList =
        DragAndDropAddon.#data(
          dataTransfer,
          DragAndDropAddon.#VSCODE_URI_LIST,
        ) ?? "",
      uriList =
        DragAndDropAddon.#data(dataTransfer, DragAndDropAddon.#URI_LIST) ?? "";
    this.#afterEarlierDrops(async () => {
      if (!this.#isCurrent(activation)) {
        // Nothing is looked up for a terminal that is replaced or gone.
        return;
      }
      this.#insert(
        drop,
        await this.#externalPaths(files, vscodeUriList, uriList, activation),
      );
    });
  }

  /**
   * Runs the rest of a drop once the drops before it are done, so that paths
   * reach the terminal in the order they were dropped: without this, a vault
   * drop would paste ahead of an earlier URI list still looked up on disk.
   */
  #afterEarlierDrops(rest: () => AsyncOrSync<void>): void {
    this.#drops = this.#drops
      .then(async () => {
        if (await this.#hasProgram()) {
          await rest();
        }
      })
      .catch((error: unknown) => {
        // Logged here, so that a drop that fails does not stop the next ones.
        activeSelf(this.element).console.error(error);
      });
  }

  /**
   * Waits until the terminal has its program. The terminal shows before its
   * program has started, with the history it had, and what is pasted in
   * between reaches no program: the terminal keeps none of it.
   *
   * @returns whether it has one. `false` when it got none: the drop is then
   * discarded without a word, as the view has said that the program did not
   * start, or the terminal was closed.
   */
  async #hasProgram(): Promise<boolean> {
    try {
      await this.attached();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pastes the dropped paths, and says so when some or all of the dropped
   * items could not become one.
   */
  #insert(drop: Drop, dropped: DroppedPaths): void {
    const { activation, focused, input, terminal } = drop;
    if (!this.#isCurrent(activation)) {
      // The terminal was replaced or went away while the drop waited.
      return;
    }
    if (dropped.paths.length === 0) {
      this.#notice("notices.drop-no-paths");
      return;
    }
    if (input !== this.#input) {
      // The user typed while the drop waited for its paths or for the drops
      // before it. After Enter the paths would go to whatever runs by now.
      this.#notice("notices.drop-skipped-paths");
      return;
    }
    const platform = deopaque(Platform.CURRENT),
      { texts, skipped } = formatDroppedPaths(
        dropped.paths,
        ...this.#writing(platform),
      );
    // One paste for all the paths, but one per path on Windows. One paste is
    // how Claude Code reads several escaped paths, and a shell reads it in
    // one go. Quoted, as most shells on Windows need them, Claude Code reads
    // them only when each is its own paste.
    for (const paste of droppedPathPastes(texts, platform)) {
      // Asked again each time: what a paste sets off may dispose the addon.
      if (!this.#isCurrent(activation)) {
        return;
      }
      this.#paste(terminal, paste);
    }
    if (!this.#isCurrent(activation)) {
      return;
    }
    // Not when the focus has moved since the drop: a drop that was slow to
    // look up must not take it back from where the user went on to work.
    if (
      texts.length > 0 &&
      this.element.ownerDocument.activeElement === focused
    ) {
      terminal.focus();
    }
    // Also when no path could be written for the shell: the dropped items
    // are files on this computer then, which the other notice would deny.
    if (dropped.skipped + skipped > 0) {
      this.#notice("notices.drop-skipped-paths");
    }
  }

  /**
   * Pastes a text. The terminal sends it to its program as data, like what
   * is typed, so it is marked as not being input of the user.
   */
  #paste(terminal: Terminal, text: string): void {
    this.#pasting = true;
    try {
      terminal.paste(text);
    } finally {
      this.#pasting = false;
    }
  }

  /**
   * Tells whether a drop of these paths inserts any of them: whether the
   * shell of the terminal has a way to write one. It stops at the first such
   * path, as it is asked at every `dragover` and a drag can carry a thousand
   * files.
   */
  #canInsert(paths: readonly string[]): boolean {
    const writing = this.#writing(deopaque(Platform.CURRENT));
    return paths.some((path) => formatDroppedPath(path, ...writing) !== null);
  }

  /**
   * Tells how a path is written for what the terminal runs: the grammar its
   * program reads, and what the profile says beyond that.
   */
  #writing(
    platform: Platform.All,
  ): readonly [ShellGrammar, DroppedPathOptions] {
    const { profile } = this;
    if (profile?.type === "developerConsole") {
      return ["javascript", {}];
    }
    // Only an integrated profile names the program in the terminal.
    const [executable, args] =
      profile?.type === "integrated"
        ? [profile.executable, profile.args]
        : ["", []];
    return [
      shellGrammar(executable, platform),
      {
        distribution: wslDistribution(args),
        maxBytes: lineByteLimit(executable, platform),
      },
    ];
  }

  #notice(key: "notices.drop-no-paths" | "notices.drop-skipped-paths"): void {
    const {
      context,
      context: { language, settings },
    } = this;
    notice2(() => language.value.t(key), settings.value.noticeTimeout, context);
  }

  /**
   * Returns the paths of a drag from outside the vault. The first source that
   * names a path wins, and the sources are never merged: a drag that carries
   * several describes the same items in each.
   */
  async #externalPaths(
    files: readonly File[],
    vscodeUriList: string,
    uriList: string,
    activation: number,
  ): Promise<DroppedPaths> {
    const native = await this.#nativePaths(files);
    if (native.paths.length > 0) {
      return native;
    }
    // An image dragged out of a web page, or out of a note in a pop-out
    // window, comes as a bitmap without a path, next to the URI it is served
    // from. VS Code gives no files at all.
    const options = {
        platform: deopaque(Platform.CURRENT),
        resourcePrefix: ObsidianPlatform.resourcePathPrefix,
      },
      // VS Code percent-encodes a `#` in a name, and adds the place of a
      // search match as a fragment, which is not part of the path.
      vscode = uriListPaths(vscodeUriList, { ...options, fragments: true });
    return this.#onDisk(
      vscode.paths.length > 0
        ? vscode
        : uriListPaths(uriList, { ...options, fragments: false }),
      activation,
    );
  }

  /**
   * Returns the paths of files dragged in from the system (Finder, Explorer,
   * Files...). They are not checked: the system handed them over, and a
   * `stat` on a slow network volume must not hold up a drop.
   */
  async #nativePaths(files: readonly File[]): Promise<DroppedPaths> {
    let webUtils: (typeof import("electron"))["webUtils"] = void 0;
    try {
      ({ webUtils } = await electron);
    } catch (error) {
      // Expected outside Electron; `File.path` is used if available.
      /* @__PURE__ */ activeSelf(this.element).console.debug(error);
    }
    const paths = files
      .map((file) => this.#nativePath(file, webUtils))
      .filter(isNonNil);
    return { paths, skipped: files.length - paths.length };
  }

  /**
   * Returns the path of a file from the system; `null` for a `File` that is
   * not a file on disk, such as an image dragged out of a web page. Whatever
   * a `File` throws stays here, so that the other dropped files keep theirs.
   */
  #nativePath(
    file: File,
    webUtils: (typeof import("electron"))["webUtils"],
  ): string | null {
    const { console } = activeSelf(this.element);
    // `webUtils.getPathForFile()` is in Electron 30 and later.
    if (webUtils) {
      try {
        const path = DragAndDropAddon.#pathOrNull(
          webUtils.getPathForFile(file),
        );
        if (path !== null) {
          return path;
        }
      } catch (error) {
        /* @__PURE__ */ console.warn(error);
      }
    }
    try {
      // eslint-disable-next-line eslint-comments/no-restricted-disable -- Need to suppress no-deprecated (see below)
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Intentional fallback for Electron versions without `webUtils.getPathForFile`.
      return DragAndDropAddon.#pathOrNull(file.path);
    } catch (error) {
      // A getter that is being removed may throw instead of returning nothing.
      /* @__PURE__ */ console.debug(error);
      return null;
    }
  }

  /**
   * Leaves out the paths of a URI list that are not files or directories on
   * disk. Unlike files from the system, a URI list is text the drag source
   * chose, so nothing in it is pasted unverified. Network hosts are refused
   * by `uriListPaths`, before anything is looked up.
   *
   * The lookup is bounded, because a list can name a thousand paths, and a
   * path on a volume that does not answer would hold up this drop and the
   * ones after it: a few paths at a time, and one deadline for all of them.
   * A path without an answer by then counts as skipped, as does one whose
   * lookup could not start, the slots being held by lookups without answer.
   */
  async #onDisk(
    listed: DroppedPaths,
    activation: number,
  ): Promise<DroppedPaths> {
    const { paths, skipped } = listed;
    if (paths.length === 0) {
      return listed;
    }
    const found = new Set<number>(),
      // One iterator for all the loops below, so each path is taken once.
      entries = paths.entries();
    let expired = false,
      timer: number | undefined;
    // The timer is one of the main window, not of the window the terminal is
    // in: a terminal can be moved out of a pop-out window, which then closes,
    // and a closed window runs none of its timers. The deadline would never
    // come, and a lookup without answer would hold up every later drop.
    const deadline = new Promise<false>((resolve) => {
        timer = self.setTimeout(() => {
          expired = true;
          resolve(false);
        }, DragAndDropAddon.#LOOKUP_DEADLINE);
      }),
      // Nobody waits for an answer after the deadline, nor once the terminal
      // is replaced or gone.
      awaited = (): boolean => !expired && this.#isCurrent(activation),
      lookUp = async (): Promise<void> => {
        for (const [index, path] of entries) {
          if (!awaited()) {
            // No lookup starts for an answer nobody waits for.
            return;
          }
          // The deadline answers for a path that has no answer by then, and
          // the late answer is ignored.
          if (
            await Promise.race([
              this.#isOnDisk(path, deadline, awaited),
              deadline,
            ])
          ) {
            found.add(index);
          }
        }
      };
    // No more paths of one drop in line for a slot than there are slots, so
    // that a long list does not keep the drop on another terminal waiting.
    await Promise.all(
      Array.from({ length: Math.min(paths.length, LOOKUPS) }, lookUp),
    );
    // Every path has its answer, or the deadline has passed.
    self.clearTimeout(timer);
    const onDisk = paths.filter((_path, index) => found.has(index));
    return { paths: onDisk, skipped: skipped + paths.length - onDisk.length };
  }

  /**
   * Tells whether a path is a file or a directory on disk, once one of the
   * {@link LOOKUPS} slots is free to ask.
   *
   * @param path - absolute path.
   * @param deadline - settles when the drop stops waiting for a slot.
   * @param awaited - tells whether the drop still waits for the answer.
   * @returns `false` as well for a path that was not looked up.
   */
  async #isOnDisk(
    path: string,
    deadline: Promise<unknown>,
    awaited: () => boolean,
  ): Promise<boolean> {
    if (!(await acquireLookup(deadline))) {
      return false;
    }
    try {
      if (!awaited()) {
        // The slot came free as the drop gave up.
        return false;
      }
      const stats = await (await fsPromises).stat(path);
      return stats.isFile() || stats.isDirectory();
    } catch (error) {
      // Missing, unreadable, or no file system to ask: not a path to insert.
      /* @__PURE__ */ activeSelf(this.element).console.debug(error);
      return false;
    } finally {
      // Only now that `stat` has answered, which can be long after the drop
      // stopped waiting for it or the terminal went away.
      releaseLookup();
    }
  }

  /**
   * Returns Obsidian's drag manager, which is not part of its API; `null`
   * without one, and vault drags are then ignored (other drops still work).
   */
  #dragManager(): object | null {
    const { app } = this.context;
    if (!("dragManager" in app)) {
      return null;
    }
    const { dragManager } = app;
    return typeof dragManager === "object" ? dragManager : null;
  }

  /**
   * Returns what is being dragged out of the vault (file explorer, search,
   * backlinks, bookmarks, links...); `null` or `undefined` outside such a drag.
   */
  #draggable(): unknown {
    const dragManager = this.#dragManager();
    return dragManager !== null && "draggable" in dragManager
      ? dragManager.draggable
      : null;
  }

  /**
   * Shows what a drop will do next to Obsidian's drag ghost, as Obsidian's own
   * drop targets do, or takes that label off again. Obsidian clears the label
   * before every `dragover`, but only in its main window.
   *
   * @param insertable - whether a drop here inserts a path.
   */
  #labelDragGhost(insertable: boolean): void {
    const dragManager = this.#dragManager();
    if (dragManager === null || !("setAction" in dragManager)) {
      return;
    }
    const { setAction } = dragManager;
    if (typeof setAction !== "function") {
      return;
    }
    const label = insertable
      ? this.context.language.value.t("components.terminal.drag-insert-path")
      : null;
    try {
      Reflect.apply(setAction, dragManager, [label]);
    } catch (error) {
      // The label is a nicety of a private API: the drag goes on without it.
      /* @__PURE__ */ activeSelf(this.element).console.debug(error);
    }
  }

  /**
   * Returns the absolute paths of the vault files and folders in a vault
   * drag. A path the vault does not know (a file deleted during the drag)
   * counts as skipped, and a vault that is not on the file system has none.
   */
  #vaultPaths(draggable: unknown): DroppedPaths {
    const { vault } = this.context.app,
      { adapter } = vault,
      dragged = vaultDragPaths(draggable);
    if (!(adapter instanceof FileSystemAdapter)) {
      return { paths: [], skipped: dragged.length };
    }
    const paths = dragged
      .filter((path) => vault.getAbstractFileByPath(path) !== null)
      .map((path) => adapter.getFullPath(path));
    return { paths, skipped: dragged.length - paths.length };
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
    // eslint-disable-next-line eslint-comments/no-restricted-disable -- Need to suppress prefer-create-el (see below)
    // eslint-disable-next-line obsidianmd/prefer-create-el -- Probe must be created in `doc` (a possibly-popout document); the global `createDiv` binds to the main window.
    const probe = doc.createElement("div");
    probe.classList.add(DOMClasses2.COLOR_PROBE);
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
      return `rgb(${String(red)}, ${String(green)}, ${String(blue)})`;
    }

    const alpha = Number(
      color.alpha.toFixed(FollowThemeAddon.#RGBA_ALPHA_DECIMALS),
    );

    return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${String(alpha)})`;
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

    revealPrivateFilter<[$App]>()(
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

    // eslint-disable-next-line eslint-comments/no-restricted-disable -- Need to suppress prefer-create-el (see below)
    // eslint-disable-next-line obsidianmd/prefer-create-el -- Probe must be created in `doc` (a possibly-popout document); the global `createSpan` binds to the main window.
    const span = doc.createElement("span");
    // A fresh element has an empty `color`; assigning the input tests whether the browser can parse it.
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
      hasAlpha = match.groups["alpha"] !== undefined,
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
    protected readonly action: () => RightClickActionAddon.Action = () =>
      "default",
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
          // eslint-disable-next-line no-fallthrough -- `copyPaste` without a selection intentionally falls through to paste.
          case "paste":
            terminal.paste(
              await activeSelf(element).navigator.clipboard.readText(),
            );
            break;
        }
      })().catch((error: unknown) => {
        activeSelf(element).console.error(error);
      });
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
 *
 * Between stages 2 and 3, ConPTY terminals can activate Win32 input mode with
 * `DECSET 9001`. The mode handlers are registered on Windows and honoured only
 * while the effective backend is ConPTY: `supportsWin32InputMode` is asked
 * when the mode is requested, because a ConHost fallback is known only after
 * the terminal opened. While active, unmatched keydown and keyup events use
 * Win32 `KEY_EVENT_RECORD` sequences. Dead keys are the exception: the browser
 * composes them, and cancelling a dead key's keydown or the keydown of the
 * character it combines with discards the composed character (UI Events
 * §Dead keys; xterm.js #3430). Both keydowns are left to the browser, and the
 * `keypress` carrying the composed character becomes the keydown record, as
 * Windows Terminal turns character events into key events. That record reuses
 * the deferred keydown's virtual key, so it keeps the layout's identity. Two
 * more kinds of key stay unencoded and go to the browser: the keydown that
 * starts an IME composition (`isImeKeyEvent`) and the clipboard chords
 * (`isWin32ClipboardChord`).
 */
export class CustomKeyEventHandlerAddon implements ITerminalAddon {
  readonly #disposer = new Functions({ async: false, settled: true });
  #terminal: Terminal | null = null;
  #win32InputMode: Win32InputMode | null = null;
  #win32InputModeActive = false;
  /** `pending` after a dead key's keydown; `composing` once the character
   * keydown it combines with was deferred to its keypress. */
  #deadKey: "composing" | "none" | "pending" = "none";
  /** Virtual key of the deferred keydown, reused by its keypresses. */
  #deadKeyVirtualKey = 0;
  /** Alt starts a candidate; numpad digits await the OS character, which may
   * arrive before or after Alt's keyup. Never derive it from the digits. */
  #altNumpad: "alt" | "composing" | "none" | "released" = "none";
  /** Suppress each participating digit's keyup, even after completion or
   * interruption. Mode reset and disposal clear this held-key tracking. */
  readonly #altNumpadCodes = new Set<string>();
  /** `code`s of the clipboard chord keys whose keydown went to the browser. */
  readonly #clipboardChordCodes = new Set<string>();

  public constructor(
    protected readonly currentPlatform: string,
    protected readonly getKeymappings: () => readonly Settings.Keymapping[],
    protected readonly isPassthroughEnabled: () => boolean,
    protected readonly supportsWin32InputMode: () => boolean,
  ) {}

  public activate(terminal: Terminal): void {
    this.#terminal = terminal;
    terminal.attachCustomKeyEventHandler((event) => this.#handleEvent(event));
    if (this.currentPlatform === "win32") {
      this.#registerWin32InputModeHandlers(terminal);
    }
  }

  public dispose(): void {
    this.#disposer.call();
    this.#terminal = null;
    this.#win32InputMode = null;
    this.#resetWin32InputMode();
  }

  #handleEvent(event: KeyboardEvent): boolean {
    const terminal = this.#terminal;

    // Guard: addon uninitialized or disposed
    if (!terminal) {
      return true;
    }

    // Block during IME composition so the input method operates unimpeded.
    if (event.isComposing) {
      this.#altNumpad = "none";
      return true;
    }

    // --- Stage 1: keymappings ---
    // Walk the ordered list; first match wins.
    for (const mapping of this.getKeymappings()) {
      if (this.#matches(event, mapping)) {
        // In active Win32 input mode, passthrough means bypass the mapping and
        // continue into Win32 encoding. Returning true here would expose the
        // event to xterm.js 6.x's legacy keyboard encoder.
        if (mapping.action === "passthrough" && this.#win32InputModeActive) {
          break;
        }
        this.#altNumpad = "none";
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

    // --- Stage 2: Windows ConPTY Win32 input mode ---
    if (this.#win32InputModeActive && this.#win32InputMode) {
      return this.#encodeWin32(terminal, this.#win32InputMode, event);
    }

    // --- Stage 3: macOS Option key passthrough ---
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

  /**
   * Win32 input mode. Dead keys defer to the browser: neither the dead key's
   * keydown nor the keydown of the character key it combines with is cancelled
   * or encoded, and the keypress carrying the composed character becomes the
   * keydown record, with the deferred keydown's virtual key. Alt+Numpad also
   * leaves its keydowns to the browser, but replaces the digits with one
   * synthetic character down/up pair once the OS supplies the character.
   */
  #encodeWin32(
    terminal: Terminal,
    mode: Win32InputMode,
    event: KeyboardEvent,
  ): boolean {
    const { type } = event,
      virtualKey = mode.virtualKey(event),
      isAltRelease =
        type === "keyup" &&
        (event.code === "AltLeft" ||
          event.code === "AltRight" ||
          virtualKey === 18);
    if (mode.isImeKeyEvent(event)) {
      this.#altNumpad = "none";
      return true;
    }
    // Returning false bypasses xterm.js 6 without cancelling native input.
    let preserveDefault = false;
    if (type === "keydown") {
      const altOnly =
        event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.getModifierState("AltGraph");
      if (event.key === "Alt" && altOnly) {
        this.#altNumpad = "alt";
        preserveDefault = true;
      } else if (
        (this.#altNumpad === "alt" || this.#altNumpad === "composing") &&
        altOnly &&
        /^Numpad[0-9]$/u.test(event.code)
      ) {
        this.#altNumpad = "composing";
        this.#altNumpadCodes.add(event.code);
        // This composition owns the character, not a previous dead key.
        this.#deadKey = "none";
        this.#deadKeyVirtualKey = 0;
        event.stopPropagation();
        return false;
      } else {
        this.#altNumpad = "none";
        this.#altNumpadCodes.delete(event.code);
      }
      if (event.key === "Dead") {
        this.#deadKey = "pending";
      } else if (this.#deadKey === "composing") {
        // The composed character's keypresses precede the next keydown.
        this.#deadKey = "none";
      } else if (
        this.#deadKey === "pending" &&
        isWin32ComposableKeyEvent(event)
      ) {
        this.#deadKey = "composing";
      }
      if (event.key === "Dead" || this.#deadKey === "composing") {
        // Cancelling either keydown discards the composition; the browser
        // delivers the result on the keypress, whose `keyCode` is the
        // character, so the key's identity is kept here.
        this.#deadKeyVirtualKey = virtualKey;
        event.stopPropagation();
        return false;
      }
      if (isWin32ClipboardChord(event, virtualKey)) {
        this.#clipboardChordCodes.add(event.code);
        return true;
      }
      this.#clipboardChordCodes.delete(event.code);
    } else if (type === "keyup" && this.#altNumpadCodes.delete(event.code)) {
      event.stopPropagation();
      return false;
    } else if (isAltRelease) {
      preserveDefault = this.#altNumpad !== "none";
      this.#altNumpad = this.#altNumpad === "composing" ? "released" : "none";
    } else if (
      type === "keyup" &&
      this.#clipboardChordCodes.delete(event.code)
    ) {
      // The application never saw this key go down. The modifiers may be up
      // already, so the chord is recognized by its key alone.
      return true;
    }
    if (type === "keydown" || type === "keyup") {
      // Alt's release may carry the OS-composed character in `key`, even
      // after its keypress. Only the synthetic pair delivers that character.
      // Copy fields explicitly: DOM KeyboardEvent getters are not enumerable.
      const keyEvent = isAltRelease
        ? {
            altKey: event.altKey,
            code: event.code,
            ctrlKey: event.ctrlKey,
            getModifierState: (modifier: string): boolean =>
              event.getModifierState(modifier),
            key: "Alt",
            keyCode: virtualKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            type,
          }
        : event;
      terminal.input(
        mode.encode(keyEvent, type === "keydown"),
        !isAltRelease && !isWin32ModifierKeyOnlyEvent(event),
      );
    } else if (
      type === "keypress" &&
      (this.#altNumpad === "composing" || this.#altNumpad === "released") &&
      Array.from(event.key).length === 1 &&
      !(event.altKey && /^Numpad[0-9]$/u.test(event.code))
    ) {
      this.#altNumpad = "none";
      const character = {
        altKey: false,
        code: "",
        ctrlKey: false,
        getModifierState: (modifier: string): boolean =>
          ["NumLock", "CapsLock", "ScrollLock"].includes(modifier) &&
          event.getModifierState(modifier),
        key: event.key,
        keyCode: 0,
        metaKey: false,
        shiftKey: false,
        type: "keypress",
      };
      terminal.input(
        mode.encode(character, true) + mode.encode(character, false),
        true,
      );
    } else if (type === "keypress" && this.#deadKey !== "none") {
      // Only a deferred keydown still produces keypresses, one per composed
      // character (`'` then `q` yields two on US-International).
      terminal.input(mode.encode(event, true, this.#deadKeyVirtualKey), true);
    }
    // A cancelled keydown produces no keypress, and a cancelled keypress
    // inserts nothing, so xterm.js sends no duplicate legacy input.
    if (!preserveDefault) {
      event.preventDefault();
    }
    event.stopPropagation();
    return false;
  }

  #registerWin32InputModeHandlers(terminal: Terminal): void {
    const setHandler = terminal.parser.registerCsiHandler(
        { final: "h", prefix: "?" },
        (params) => {
          if (
            params.some((parameter) => parameter === 9001) &&
            this.supportsWin32InputMode()
          ) {
            this.#win32InputMode ??= new Win32InputMode();
            this.#win32InputModeActive = true;
          }
          // Preserve xterm.js processing for this and every unrelated mode.
          return false;
        },
      ),
      resetHandler = terminal.parser.registerCsiHandler(
        { final: "l", prefix: "?" },
        (params) => {
          if (params.some((parameter) => parameter === 9001)) {
            this.#resetWin32InputMode();
          }
          return false;
        },
      );

    this.#disposer.push(
      () => {
        setHandler.dispose();
      },
      () => {
        resetHandler.dispose();
      },
    );
  }

  #resetWin32InputMode(): void {
    this.#win32InputModeActive = false;
    this.#deadKey = "none";
    this.#deadKeyVirtualKey = 0;
    this.#clipboardChordCodes.clear();
    this.#altNumpad = "none";
    this.#altNumpadCodes.clear();
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
 * Whether the browser combines this key with a pending dead key: an
 * unmodified character key. Chords get no character event on Windows, and
 * modifier and navigation keys leave the dead key pending, as the OS does.
 */
function isWin32ComposableKeyEvent(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
  );
}

/** Keep modifier-only records from changing xterm's user-input state. */
function isWin32ModifierKeyOnlyEvent(event: KeyboardEvent): boolean {
  const { key } = event;
  return (
    key === "Alt" ||
    key === "AltGraph" ||
    key === "Control" ||
    key === "ContextMenu" ||
    key === "Meta" ||
    key === "Shift"
  );
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
          window.setTimeout(() => {
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
 * blocks (begin: `\x1b[?2026h`, end: `\x1b[?2026l`).
 *
 * AI coding agents (e.g., pi, Claude Code) use synchronized output with ED2
 * (`\x1b[2J`) inside each block to atomically redraw their TUI. xterm.js 6.x
 * buffers row renders during the block but does not guard `ydisp`; when the
 * buffer is full and the user is scrolled up, `Buffer.scroll()` walks `ydisp`
 * toward 0 on each scroll call — the render at block-end sees this drifted
 * value and paints "topmost content" for one frame (scroll yank).
 *
 * This addon addresses that by saving `viewportY` and `baseY` at block entry
 * (`\x1b[?2026h`) and restoring the equivalent position at block exit
 * (`\x1b[?2026l`) via `queueMicrotask`, which fires after all synchronous
 * processing in the current task but before the next animation frame — so the
 * ydisp correction lands before xterm's buffered render fires and no visible
 * flash occurs.
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
            queueMicrotask(() => {
              if (atBottom) {
                terminal.scrollToBottom();
              } else {
                const { active } = terminal.buffer;
                // Adjust for baseY growth: content writes during the block push
                // old screen rows into scrollback, incrementing baseY. Preserve
                // the user's distance from the top of scrollback by shifting
                // viewportY by the same delta.
                const delta = active.baseY - bY;
                terminal.scrollToLine(
                  Math.min(Math.max(0, vY + delta), active.baseY),
                );
              }
            });
          }
        }
        // Return false so xterm still processes the sequence normally.
        return false;
      },
    );

    this.#disposer.push(() => {
      beginHandler.dispose();
      endHandler.dispose();
    });
  }

  public dispose(): void {
    this.#disposer.call();
  }
}

// Detects vault-relative .md file paths in the terminal and opens them in
// Obsidian's viewer on click, instead of the system default application.
//
// Supports two path formats that appear in terminal output:
//   1. Parenthesized (may contain spaces): (wiki/goals/My File.md)
//   2. Bare paths (no spaces):             wiki/some/file.md
export class VaultFileLinksAddon implements ITerminalAddon {
  readonly #disposer = new Functions({ async: false, settled: true });

  // Parenthesized paths: (path/to/file.md) — spaces inside are allowed
  static readonly #PAREN_REGEX = /\(([^)\n]+\.md)\)/g;

  // Bare space-free paths: path/to/file.md
  static readonly #BARE_REGEX =
    /(?:^|[\s"'])([^\s"'()[\]{}<>|\\:]+\.md)(?=[\s"'()[\]{}<>|\\:,;]|$)/gm;

  public constructor(protected readonly context: PluginContext) {}

  public activate(terminal: Terminal): void {
    const {
      context: { app },
    } = this;

    const disposable = terminal.registerLinkProvider({
      provideLinks: (
        bufferLineNumber: number,
        callback: (links: ILink[] | undefined) => void,
      ): void => {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback([]);
          return;
        }

        const lineText = line.translateToString(true);
        const { links: parenLinks, ranges: parenRanges } =
          VaultFileLinksAddon.#processParenLinks(
            lineText,
            bufferLineNumber,
            app,
            terminal,
          );
        const bareLinks = VaultFileLinksAddon.#processBareLinks(
          lineText,
          bufferLineNumber,
          app,
          terminal,
          parenRanges,
        );
        callback([...parenLinks, ...bareLinks]);
      },
    });

    this.#disposer.push(() => {
      disposable.dispose();
    });
  }

  public dispose(): void {
    this.#disposer.call();
  }

  /** Converts a string character index to a 0-based visual terminal column,
   * counting double-width (CJK and ambiguous-width) characters as 2 columns. */
  static visualColumn(text: string, charIndex: number): number {
    let col = 0;
    for (let i = 0; i < charIndex && i < text.length;) {
      const cp = text.codePointAt(i) ?? 0;
      col += eastAsianWidth(cp, { ambiguousAsWide: true });
      i += cp > 0xffff ? 2 : 1;
    }
    return col;
  }

  static makeLink(
    lineText: string,
    filePath: string,
    textStart: number,
    bufferLineNumber: number,
    app: PluginContext["app"],
    terminal: Terminal,
  ): ILink | null {
    const file = app.vault.getFileByPath(filePath);
    if (!file) return null;
    const startX = this.visualColumn(lineText, textStart) + 1;
    const endX = this.visualColumn(lineText, textStart + filePath.length);
    return {
      range: {
        end: { x: endX, y: bufferLineNumber },
        start: { x: startX, y: bufferLineNumber },
      },
      text: filePath,

      activate(_event: MouseEvent, _text: string): void {
        app.workspace
          .getLeaf(false)
          .openFile(file)
          .catch((error: unknown) => {
            activeSelf(terminal.element).console.error(error);
          });
      },
    };
  }

  static #processParenLinks(
    lineText: string,
    bufferLineNumber: number,
    app: PluginContext["app"],
    terminal: Terminal,
  ): {
    links: readonly ILink[];
    ranges: readonly { readonly start: number; readonly end: number }[];
  } {
    const links: ILink[] = [];
    const ranges: { readonly start: number; readonly end: number }[] = [];
    for (const match of lineText.matchAll(this.#PAREN_REGEX)) {
      if (!match[1]) continue;
      const link = this.makeLink(
        lineText,
        match[1],
        match.index + 1,
        bufferLineNumber,
        app,
        terminal,
      );
      if (link) links.push(link);
      ranges.push({
        start: match.index + 1,
        end: match.index + 1 + match[1].length,
      });
    }
    return { links, ranges };
  }

  static #processBareLinks(
    lineText: string,
    bufferLineNumber: number,
    app: PluginContext["app"],
    terminal: Terminal,
    parenRanges: readonly { readonly start: number; readonly end: number }[],
  ): readonly ILink[] {
    const links: ILink[] = [];
    for (const match of lineText.matchAll(this.#BARE_REGEX)) {
      if (!match[1]) continue;
      const prefixLen = match[0].length - match[1].length;
      const bareStart = match.index + prefixLen;
      const bareEnd = bareStart + match[1].length;
      if (parenRanges.some((r) => bareStart >= r.start && bareEnd <= r.end))
        continue;
      const link = this.makeLink(
        lineText,
        match[1],
        bareStart,
        bufferLineNumber,
        app,
        terminal,
      );
      if (link) links.push(link);
    }
    return links;
  }
}
