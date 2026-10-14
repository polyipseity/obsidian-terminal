/**
 * Puts a terminal's program status on its tab header.
 *
 * The header only ever receives `data-` attributes; `tab-status.css` draws
 * everything from them. Obsidian keeps attributes on the header across
 * `updateHeader()`, tab activation and layout changes, while any element
 * inserted there would be thrown away.
 */
import type { Settings } from "../settings-data.js";
import { whileSettingsHold, type WatchedSettings } from "../experiments.js";
import type { State } from "./program-status.js";
import { TAB_ICON_SIZE } from "./tab-icons.js";

/** What the tab shows: a reported state, or `seen` for a finished one the user has looked at. */
export type TabStatusDisplay = State | "seen";

/** How the marks move: `still` or `animated`. Program status None draws none. */
export type TabStatusMotion = Exclude<Settings.TabStatus, "none">;

/** The settings that decide how a status looks. */
export interface TabStatusLook {
  /** Whether anything moves: the dots of a working program, a new mark, a new title. */
  readonly motion: TabStatusMotion;
}

/** Attribute names written on the tab header. The stylesheet depends on them. */
export const TAB_STATUS_ATTRIBUTES = Object.freeze({
  /** `still` or `animated`; only while Program status is not None. */
  motion: "data-terminal-motion",
  /** Transient, under `animated`: a new state that asks for the user pops in. */
  pop: "data-terminal-pop",
  /** `TAB_ICON_SIZE` on every terminal tab header, whatever Program status says. */
  size: "data-terminal-size",
  status: "data-terminal-status",
  /** Transient, under `animated`: a new title slides up. */
  title: "data-terminal-title-change",
});

/**
 * How long a transient attribute stays at most, in milliseconds: a little
 * longer than its animation in `tab-status.css`. The end of the animation
 * takes it back; this is for where none runs (reduced motion, a hidden
 * tab).
 */
export const TAB_STATUS_TRANSIENT_TIMEOUTS = Object.freeze({
  pop: 600,
  title: 400,
});

/**
 * How long after a title starts to slide in, in milliseconds, another title
 * appears in place without one: a program that renames its terminal many
 * times a second would otherwise keep the title faded and moving.
 */
export const TAB_STATUS_TITLE_COOLDOWN = 1000;

/** The names of the keyframes each transient attribute plays. */
export const TAB_STATUS_KEYFRAMES = Object.freeze({
  pop: "tts-pop",
  title: "tts-title",
});

/** States that ask for the user's attention when they arrive unseen. */
const ATTENTION_STATES: ReadonlySet<TabStatusDisplay> =
  new Set<TabStatusDisplay>(["blocked", "done", "error"]);

/**
 * The look the user chose, from the settings. None has no look of its own:
 * nothing is drawn under it, and a preview of it shows the marks still.
 *
 * @param settings the settings, or the one of them that makes the look
 * @returns the look
 */
export function tabStatusLook(
  settings: Pick<Settings, "tabStatus">,
): TabStatusLook {
  return {
    motion: settings.tabStatus === "animated" ? "animated" : "still",
  };
}

/**
 * Whether the tab shows a program's status at all.
 *
 * @param settings the settings, or the one of them that says it
 * @returns `false` under Program status None
 */
export function isTabStatusShown(
  settings: Pick<Settings, "tabStatus">,
): boolean {
  return settings.tabStatus !== "none";
}

/**
 * Runs `start` while Program status is not None, as `whileSettingsHold`
 * does: at once if it already is not, again each time it is turned from
 * None, and stops when it is turned to None. A change between Still and
 * Animated neither starts nor stops anything.
 *
 * @param settings the plugin's settings manager
 * @param start starts what shows a status and returns what stops it
 * @returns stops it and ends the subscription; register it with the owner
 */
export function whileTabStatusShown<S extends Pick<Settings, "tabStatus">>(
  settings: WatchedSettings<S>,
  start: () => () => void,
): () => void {
  return whileSettingsHold(
    settings,
    isTabStatusShown,
    "Program status on tabs",
    start,
  );
}

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
 * Tells a tab header how large its icon is: `TAB_ICON_SIZE`, on every
 * terminal tab, whatever Program status says.
 *
 * A loaded view writes it on its own header. Obsidian does not load the view
 * of a background tab until the tab is opened; until then the header has
 * the terminal's type and the icon saved with the layout, and no view of
 * ours, so the plugin writes it there (`TerminalView.dressUnloadedTabs`).
 *
 * @param header the tab header
 */
export function writeTabIconSize(header: Element): void {
  writeAttribute(header, TAB_STATUS_ATTRIBUTES.size, String(TAB_ICON_SIZE));
}

/**
 * Draws the tab icon on a tab nobody presents.
 *
 * Such a tab shows the icon saved with the layout: an icon of an earlier
 * version, or nothing where that icon is no longer registered. Obsidian
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
 * An attribute that an element carries only while the CSS animation it
 * starts plays: set, then taken back at the end of the animation (or after
 * `timeout`, where none runs). Set again while it plays, the animation
 * starts over.
 */
export class TransientAttribute {
  #element: Element | null = null;
  #timer: number | null = null;
  readonly #ended = (event: Event): void => {
    // The event bubbles from the element that plays, and other animations
    // around it end too.
    if ("animationName" in event && event.animationName === this.keyframes) {
      this.stop();
    }
  };

  /**
   * @param name the attribute
   * @param keyframes the name of the keyframes it plays
   * @param timeout how long it stays at most, in milliseconds
   */
  public constructor(
    protected readonly name: string,
    protected readonly keyframes: string,
    protected readonly timeout: number,
  ) {}

  /** Its value while it plays, or `null`. */
  public get value(): string | null {
    return this.#element?.getAttribute(this.name) ?? null;
  }

  /**
   * Sets the attribute, or sets it again: the animation starts over.
   *
   * @param element the tab header, or what stands in for it
   * @param value the attribute's value
   */
  public play(element: Element, value: string): void {
    const again = this.#element === element;
    this.stop();
    if (again) {
      // An attribute taken off and put back in one task is no change to the
      // browser: a layout in between makes it drop the running animation,
      // so the new one starts from its beginning.
      element.getBoundingClientRect();
    }
    element.setAttribute(this.name, value);
    element.addEventListener("animationend", this.#ended);
    this.#timer = self.setTimeout(() => {
      this.stop();
    }, this.timeout);
    this.#element = element;
  }

  /** Takes the attribute back at once. Safe to call at any time. */
  public stop(): void {
    const element = this.#element;
    if (element === null) {
      return;
    }
    this.#element = null;
    element.removeAttribute(this.name);
    element.removeEventListener("animationend", this.#ended);
    if (this.#timer !== null) {
      self.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/**
 * Keeps one tab's status and writes it to the header.
 *
 * Writes are idempotent and only touch attributes whose value changed, so a
 * program that reports often costs nothing once the header is up to date.
 * The size of the tab's icon is not the presenter's: it is on every terminal
 * tab (`writeTabIconSize`).
 */
export class TabStatusPresenter {
  #state: State | null = null;
  #seen = true;
  /** What the header was last given to show. */
  #drawn: TabStatusDisplay | null = null;
  /**
   * A report made a state that asks for the user unseen again without
   * changing what the tab shows: the next render pops it all the same.
   */
  #renotify = false;
  /** Runs from the start of a title's slide until `TAB_STATUS_TITLE_COOLDOWN`. */
  #titleCooldown: number | null = null;
  readonly #pop = new TransientAttribute(
    TAB_STATUS_ATTRIBUTES.pop,
    TAB_STATUS_KEYFRAMES.pop,
    TAB_STATUS_TRANSIENT_TIMEOUTS.pop,
  );
  readonly #title = new TransientAttribute(
    TAB_STATUS_ATTRIBUTES.title,
    TAB_STATUS_KEYFRAMES.title,
    TAB_STATUS_TRANSIENT_TIMEOUTS.title,
  );

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
    const wasSeen = this.#seen;
    this.#state = state;
    this.#seen =
      state === null || !ATTENTION_STATES.has(state) || this.options.lookedAt();
    // The program asks again for what the user has seen: also a reason to
    // pop, where the tab's mark stays the same. Only a report sets this.
    this.#renotify = wasSeen && !this.#seen;
    this.render();
  }

  /** The user is looking at the tab now. */
  public look(): void {
    if (this.#seen) {
      return;
    }
    this.#seen = true;
    this.render();
  }

  /**
   * Writes the current status and look to the header. Safe to call at any
   * time. Under `animated`, a status that asks for the user pops in when it
   * was not shown before, or when a report has just made it unseen again.
   */
  public render(): void {
    // Taken here whatever happens next: a pop that cannot play now never
    // plays later.
    const renotify = this.#renotify;
    this.#renotify = false;
    const header = this.options.header();
    if (!header) {
      return;
    }
    const shown = this.shown(),
      before = this.#drawn,
      { motion } = this.options.look();
    this.#drawn = shown;
    writeAttribute(header, TAB_STATUS_ATTRIBUTES.status, shown);
    // Nothing here keeps anything moving: under "animated" the stylesheet
    // does, from these attributes alone, while the status is "working".
    writeAttribute(header, TAB_STATUS_ATTRIBUTES.motion, motion);
    if (motion !== "animated") {
      this.#pop.stop();
      this.#title.stop();
      return;
    }
    if (
      (shown !== before || renotify) &&
      shown !== null &&
      ATTENTION_STATES.has(shown)
    ) {
      this.#pop.play(header, shown);
    } else if (this.#pop.value !== null && this.#pop.value !== shown) {
      // Another mark is shown by now: it does not pop.
      this.#pop.stop();
    }
  }

  /**
   * The header's title has just changed. Under `animated` it slides in,
   * unless a slide plays or started less than `TAB_STATUS_TITLE_COOLDOWN`
   * ago: then it only replaces the title. The caller decides what counts as
   * a change: not the first title a tab is drawn with.
   */
  public titleChanged(): void {
    const header = this.options.header();
    if (
      !header ||
      this.options.look().motion !== "animated" ||
      this.#title.value !== null ||
      this.#titleCooldown !== null
    ) {
      return;
    }
    this.#title.play(header, "");
    this.#titleCooldown = self.setTimeout(() => {
      this.#titleCooldown = null;
    }, TAB_STATUS_TITLE_COOLDOWN);
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

  /**
   * Removes everything this presenter wrote. The header outlives the view.
   * The size stays: it is not the presenter's.
   */
  public clear(): void {
    this.#state = null;
    this.#seen = true;
    this.#drawn = null;
    this.#renotify = false;
    this.#pop.stop();
    this.#title.stop();
    if (this.#titleCooldown !== null) {
      self.clearTimeout(this.#titleCooldown);
      this.#titleCooldown = null;
    }
    const header = this.options.header();
    if (!header) {
      return;
    }
    writeAttribute(header, TAB_STATUS_ATTRIBUTES.status, null);
    writeAttribute(header, TAB_STATUS_ATTRIBUTES.motion, null);
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
 * @param element the tab header, or what stands in for it in a preview
 * @param name attribute name
 * @param value attribute value, or `null` to remove the attribute
 */
export function writeAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (element.getAttribute(name) === value) {
    return;
  }
  if (value === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}
