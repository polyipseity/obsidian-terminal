/**
 * Puts a terminal's program status on its tab header.
 *
 * The header only ever receives `data-` attributes; `tab-status.css` draws
 * everything from them. Obsidian keeps attributes on the header across
 * `updateHeader()`, tab activation and layout changes, while any element
 * inserted there would be thrown away.
 */
import type { Settings } from "../settings-data.js";
import type { State } from "./program-status.js";

/** What the tab shows: a reported state, or `seen` for a finished one the user has looked at. */
export type TabStatusDisplay = State | "seen";

/** The settings that decide how a status looks. */
export interface TabStatusLook {
  /** The icon set. The tab's icon is of it; nothing is written for it. */
  readonly set: Settings.TabIconSet;
  /** The icon's size on the tab, in CSS pixels. */
  readonly size: Settings.TabIconSize;
  /** Whether the mark of a working program keeps moving. */
  readonly animation: Settings.TabStatusAnimation;
}

/** Attribute names written on the tab header. The stylesheet depends on them. */
export const TAB_STATUS_ATTRIBUTES = Object.freeze({
  animation: "data-terminal-animation",
  size: "data-terminal-size",
  status: "data-terminal-status",
});

/** States that ask for the user's attention when they arrive unseen. */
const ATTENTION_STATES: ReadonlySet<State> = new Set<State>([
  "blocked",
  "done",
  "error",
]);

/**
 * Whether a state asks for the user when it arrives while they are elsewhere.
 *
 * @param state a reported state
 * @returns `true` for done, needs input and error
 */
export function needsAttention(state: State): boolean {
  return ATTENTION_STATES.has(state);
}

/**
 * Tells a tab header how large its icon is, for a tab nobody presents.
 *
 * Obsidian does not load the view of a background tab until the tab is
 * opened. Until then the header has the terminal's type and the icon saved
 * with the layout, but no view and so no presenter. The size, and the chosen
 * icon (`writeTabIcon`), are what it needs to stand like its neighbours.
 *
 * @param header the tab header
 * @param size the icon's size in CSS pixels, or `null` to take it back
 */
export function writeTabIconSize(
  header: Element,
  size: Settings.TabIconSize | null,
): void {
  write(
    header,
    TAB_STATUS_ATTRIBUTES.size,
    size === null ? null : String(size),
  );
}

/**
 * Draws the chosen icon on a tab nobody presents.
 *
 * Such a tab shows the icon saved with the layout: the set chosen when the
 * layout was saved, or the icon of a version before there were sets. Obsidian
 * marks a drawn icon with its id as a class, which is how an icon that is
 * already right is told and left alone.
 *
 * @param icon the element that holds the tab's icon
 * @param id the icon's registered id
 * @param draw Obsidian's `setIcon`
 */
export function writeTabIcon(
  icon: HTMLElement,
  id: string,
  draw: (element: HTMLElement, id: string) => void,
): void {
  if (icon.firstElementChild?.classList.contains(id) === true) {
    return;
  }
  draw(icon, id);
}

/**
 * Listens for the focus of the window an element is in, and goes with the
 * element when Obsidian moves it to another window (a tab dragged out into a
 * popout, or back).
 *
 * @param element the element; its `onWindowMigrated` says where it went
 * @param win the window the element is in now
 * @param listener called whenever the element's window gets the focus
 * @returns stops listening
 */
export function onWindowFocus(
  element: HTMLElement,
  win: EventTarget,
  listener: () => void,
): () => void {
  const options = { passive: true } as const;
  // Mutable: the window changes when the element moves.
  let current: EventTarget = win;
  current.addEventListener("focus", listener, options);
  const unfollow = element.onWindowMigrated((next) => {
    current.removeEventListener("focus", listener);
    current = next;
    current.addEventListener("focus", listener, options);
  });
  return () => {
    unfollow();
    current.removeEventListener("focus", listener);
  };
}

/**
 * Keeps one tab's status and writes it to the header.
 *
 * Writes are idempotent and only touch attributes whose value changed, so a
 * program that reports often costs nothing once the header is up to date.
 */
export class TabStatusPresenter {
  #state: State | null = null;
  #seen = true;
  /** What the tab showed when a settings change took its status away. */
  #held: { readonly seen: boolean; readonly state: State | null } | null = null;

  public constructor(protected readonly options: TabStatusPresenter.Options) {}

  /** The status the tab shows, or `null` when the program has reported nothing. */
  public get display(): TabStatusDisplay | null {
    return this.shown();
  }

  /** Whether something arrived that the user has not looked at yet. */
  public get unread(): boolean {
    return !this.#seen && this.#state !== null && needsAttention(this.#state);
  }

  /**
   * Takes the program's current state. `null` means nothing is reported.
   *
   * @param state the most urgent reported state
   */
  public report(state: State | null): void {
    this.#held = null;
    this.#state = state;
    this.#seen =
      state === null || !ATTENTION_STATES.has(state) || this.options.lookedAt();
    this.render();
  }

  /**
   * Takes the program's state after a settings change. Nothing arrived, so
   * what the user has seen stays seen, and what they have not stays unseen:
   * when reports are turned off and on again, the state that comes back is
   * the one that went, as it was (also if the user looked at the terminal
   * meanwhile: nothing was on the tab to see). Only a state that differs
   * from it counts as a report.
   *
   * @param state the most urgent reported state
   */
  public sync(state: State | null): void {
    if (state === this.#state) {
      this.render();
      return;
    }
    const held = this.#held;
    if (state === null) {
      // Reports were turned off: keep what the tab showed for their return.
      this.#held = { seen: this.#seen, state: this.#state };
      this.#state = null;
      this.#seen = true;
      this.render();
      return;
    }
    if (this.#state === null && held?.state === state) {
      this.#held = null;
      this.#state = state;
      this.#seen = held.seen;
      this.render();
      return;
    }
    this.report(state);
  }

  /** The user is looking at the tab now. */
  public look(): void {
    if (this.#seen) {
      return;
    }
    this.#seen = true;
    this.render();
  }

  /** Writes the current status and look to the header. Safe to call at any time. */
  public render(): void {
    const header = this.options.header();
    if (!header) {
      return;
    }
    const look = this.options.look();
    write(header, TAB_STATUS_ATTRIBUTES.status, this.shown());
    write(header, TAB_STATUS_ATTRIBUTES.size, String(look.size));
    // Nothing here keeps anything moving: under animation "loop" the
    // stylesheet does, from these attributes alone, while the status is
    // "working".
    write(header, TAB_STATUS_ATTRIBUTES.animation, look.animation);
  }

  /**
   * A finished program stays highlighted until the user has looked at it,
   * and shows as seen from then on. Needs input and error are live states
   * and keep their own look either way.
   *
   * @returns the status to show
   */
  protected shown(): TabStatusDisplay | null {
    const state = this.#state;
    return state === "done" && this.#seen ? "seen" : state;
  }

  /** Removes everything this presenter wrote. The header outlives the view. */
  public clear(): void {
    this.#held = null;
    this.#state = null;
    this.#seen = true;
    const header = this.options.header();
    if (!header) {
      return;
    }
    for (const name of Object.values(TAB_STATUS_ATTRIBUTES)) {
      write(header, name, null);
    }
  }
}
export namespace TabStatusPresenter {
  export interface Options {
    /** The tab header, or `null` while there is none. Read on every write. */
    readonly header: () => Element | null;
    /** The current look, read on every write. */
    readonly look: () => TabStatusLook;
    /** Whether the user is looking at this terminal right now. */
    readonly lookedAt: () => boolean;
  }
}

/**
 * Sets or removes one attribute, leaving the element alone when nothing changes.
 *
 * @param element the tab header
 * @param name attribute name
 * @param value attribute value, or `null` to remove the attribute
 */
function write(element: Element, name: string, value: string | null): void {
  if (element.getAttribute(name) === value) {
    return;
  }
  if (value === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}
