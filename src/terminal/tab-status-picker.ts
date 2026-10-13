/**
 * The visual half of the "Tab status" settings: a strip of mock tabs that
 * shows the current look, and pickers whose options are drawn on real icons.
 *
 * Nothing here draws an icon. A preview host is an element with class
 * `tts-host` and the `data-terminal-*` attributes of a tab header, holding an
 * element with class `tts-host-icon`, holding the icon; `tab-status.css`
 * draws it exactly as it draws a tab. This module only writes attributes.
 *
 * Plain DOM code: every element comes from the parent's own document (the
 * settings may live in another window), and what belongs to Obsidian
 * (`setIcon`, `setTooltip`) is passed in.
 */
import type { Settings } from "../settings-data.js";
import {
  TAB_STATUS_ATTRIBUTES,
  type TabStatusDisplay,
  type TabStatusLook,
} from "./tab-status.js";

/** What the module needs from Obsidian. */
export interface TabStatusPreviewEnvironment {
  /** Obsidian's `setIcon`. May leave the element empty for an unknown id. */
  readonly setIcon: (element: HTMLElement, id: string) => void;
  /** Obsidian's `setTooltip`. */
  readonly setTooltip: (element: HTMLElement, text: string) => void;
}

/** The `data-terminal-*` attributes of a host, by their key in `TAB_STATUS_ATTRIBUTES`. A missing key removes the attribute. */
export interface TabStatusHostAttributes {
  readonly animation?: string | undefined;
  /** The icon's size in CSS pixels. Without it a host shows its icon at the size its place gives it. */
  readonly size?: string | undefined;
  readonly status?: string | undefined;
}

/** One icon of a preview. */
export interface TabStatusPreviewHost {
  /** The id handed to `setIcon`. */
  readonly icon: string;
  readonly attributes: TabStatusHostAttributes;
}

/** The five tabs of the preview strip, in order. */
export type TabStatusPreviewState =
  "none" | "working" | "done" | "blocked" | "error";
export const TAB_STATUS_PREVIEW_STATES: readonly TabStatusPreviewState[] =
  Object.freeze(["none", "working", "done", "blocked", "error"]);

const CLASSES = Object.freeze({
  caption: "tts-pick-caption",
  captionPreview: "tts-pick-caption-preview",
  host: "tts-host",
  hostIcon: "tts-host-icon",
  picker: "tts-pick",
  pickerHost: "tts-pick-host",
  strip: "tts-strip",
  stripBar: "tts-strip-bar",
  stripCurrent: "is-active",
  stripTab: "tts-strip-tab",
  stripTitle: "tts-strip-title",
  tile: "tts-pick-tile",
  tileHosts: "tts-pick-hosts",
  tileText: "tts-pick-text",
  tileTextOnly: "tts-pick-tile-text",
  tiles: "tts-pick-tiles",
});

/**
 * The attributes a tab header would carry for a look and a status, without
 * the size: a tile of a picker shows its icon enlarged.
 *
 * @param look the settings that decide the look
 * @param status the status shown, or `null` for a tab without a report
 * @returns the attributes of a preview host
 */
export function tabStatusHostAttributes(
  look: TabStatusLook,
  status: TabStatusDisplay | null,
): TabStatusHostAttributes {
  return {
    animation: look.animation,
    ...(status === null ? {} : { status }),
  };
}

/**
 * What one tab of the preview strip carries. Mirrors `TabStatusPresenter`:
 * the tabs other than the first are ones the user is not looking at, so a
 * finished program there is unread. The strip is a piece of the tab bar, so
 * its icons have the chosen size.
 *
 * @param look the settings that decide the look
 * @param state which of the five tabs
 * @returns the attributes of that tab
 */
export function tabStatusPreviewAttributes(
  look: TabStatusLook,
  state: TabStatusPreviewState,
): TabStatusHostAttributes {
  const size = String(look.size);
  switch (state) {
    case "none":
      return { ...tabStatusHostAttributes(look, null), size };
    case "done":
    case "working":
    case "blocked":
    case "error":
      return { ...tabStatusHostAttributes(look, state), size };
  }
}

/** Describes the tiles of one picker: the option `value` on top of the current look. */
type Describe<V> = (
  look: TabStatusLook,
  value: V,
  icon: (set: Settings.TabIconSet) => string,
) => readonly TabStatusPreviewHost[];

/**
 * What each option of each picker shows. Every tile starts from the current
 * look, so it follows the other settings, and changes the one thing it is
 * about.
 */
export const TAB_STATUS_PICKER_HOSTS: {
  readonly set: Describe<Settings.TabIconSet>;
  readonly size: Describe<Settings.TabIconSize>;
  readonly animation: Describe<Settings.TabStatusAnimation>;
} = Object.freeze({
  /** A working program: its three dots, standing still or moving. */
  animation: (look, value, icon) => [
    {
      attributes: tabStatusHostAttributes(
        { ...look, animation: value },
        "working",
      ),
      icon: icon(look.set),
    },
  ],
  /** The icon at rest. */
  set: (look, value, icon) => [
    {
      attributes: tabStatusHostAttributes(look, null),
      icon: icon(value),
    },
  ],
  /** The icon at rest, at that size and not enlarged: sizes are compared as they are. */
  size: (look, value, icon) => [
    {
      attributes: {
        ...tabStatusHostAttributes(look, null),
        size: String(value),
      },
      icon: icon(look.set),
    },
  ],
});

/**
 * Sets or removes one attribute, leaving the element alone when nothing changes.
 *
 * @param element the element
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

/**
 * Creates an element in the parent's own document and appends it.
 *
 * @param parent where the element goes
 * @param tag its tag name
 * @param classes its classes
 * @returns the element
 */
function child<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  ...classes: readonly string[]
): HTMLElementTagNameMap[K] {
  // eslint-disable-next-line eslint-comments/no-restricted-disable -- Need to suppress prefer-create-el (see below)
  // eslint-disable-next-line obsidianmd/prefer-create-el -- Plain DOM module: Obsidian's window helpers exist neither in the tests nor on the preview page
  const element = parent.ownerDocument.createElement(tag);
  element.classList.add(...classes);
  parent.append(element);
  return element;
}

/** Sets the text of an element, leaving it alone when nothing changes. */
function writeText(element: Element, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function writeAttributes(
  element: Element,
  attributes: TabStatusHostAttributes,
): void {
  const names = TAB_STATUS_ATTRIBUTES;
  write(element, names.animation, attributes.animation ?? null);
  write(element, names.size, attributes.size ?? null);
  write(element, names.status, attributes.status ?? null);
}

/** One `tts-host` element and the icon inside it. */
class PreviewHost {
  public readonly iconElement: HTMLElement;
  #icon: string | null = null;

  public constructor(
    public readonly element: HTMLElement,
    protected readonly environment: TabStatusPreviewEnvironment,
  ) {
    element.classList.add(CLASSES.host);
    this.iconElement = child(element, "span", CLASSES.hostIcon);
  }

  /** Whether `setIcon` left the icon element empty. */
  public get empty(): boolean {
    return this.iconElement.childElementCount === 0;
  }

  /**
   * Shows a host. The icon is set again only when its id changed.
   *
   * @param host what to show
   */
  public show(host: TabStatusPreviewHost): void {
    if (host.icon !== this.#icon) {
      this.#icon = host.icon;
      this.iconElement.replaceChildren();
      this.environment.setIcon(this.iconElement, host.icon);
    }
    writeAttributes(this.element, host.attributes);
  }
}

/**
 * A row of mock tabs, one per state, each drawn with the current look.
 */
export class TabStatusStrip {
  public readonly element: HTMLElement;
  readonly #bar: HTMLElement;
  readonly #tabs: {
    readonly host: PreviewHost;
    readonly title: HTMLElement;
  }[] = [];

  public constructor(
    parent: HTMLElement,
    protected readonly environment: TabStatusPreviewEnvironment,
  ) {
    this.element = child(parent, "div", CLASSES.strip);
    this.element.setAttribute("role", "group");
    this.#bar = child(this.element, "div", CLASSES.stripBar);
  }

  /**
   * Shows the tabs. Elements are kept and only what changed is written.
   *
   * @param state the label of the strip and its tabs, in order
   */
  public update(state: TabStatusStrip.State): void {
    const tabs = this.#tabs;
    write(this.element, "aria-label", state.label);
    for (const extra of tabs.splice(state.tabs.length)) {
      extra.host.element.remove();
    }
    state.tabs.forEach((tab, index) => {
      let entry = tabs[index];
      if (!entry) {
        // The tab is the host, as a tab header is; its icon comes before its title.
        const element = child(this.#bar, "div", CLASSES.stripTab),
          host = new PreviewHost(element, this.environment);
        entry = { host, title: child(element, "span", CLASSES.stripTitle) };
        tabs.push(entry);
      }
      entry.host.show(tab.host);
      entry.host.element.classList.toggle(
        CLASSES.stripCurrent,
        tab.current ?? false,
      );
      writeText(entry.title, tab.caption);
    });
  }

  public destroy(): void {
    this.#tabs.length = 0;
    this.element.remove();
  }
}
export namespace TabStatusStrip {
  export interface Tab {
    /** The words on the tab. */
    readonly caption: string;
    readonly host: TabStatusPreviewHost;
    /** Drawn as the tab the user is on. */
    readonly current?: boolean;
  }
  export interface State {
    /** The accessible name of the strip. */
    readonly label: string;
    readonly tabs: readonly Tab[];
  }
}

interface Tile<V extends string> {
  readonly value: V;
  readonly element: HTMLButtonElement;
  readonly hostsElement: HTMLElement;
  readonly textElement: HTMLElement;
  readonly hosts: PreviewHost[];
  label: string;
  /** The pointer is on the tile. */
  hover: boolean;
  /** The keyboard focus is on the tile. */
  focus: boolean;
}

/**
 * A radio group whose options are tiles that show the option on real icons.
 *
 * One tab stop; arrow keys move and choose, as do Home and End; Space and
 * Enter choose. Under the tiles a line says the chosen option in words, and
 * the option under the pointer or the focus while there is one.
 */
export class TabStatusPicker<V extends string> {
  public readonly element: HTMLElement;
  readonly #tilesElement: HTMLElement;
  readonly #caption: HTMLElement;
  readonly #tiles: Tile<V>[] = [];
  #value: V | null = null;

  public constructor(
    parent: HTMLElement,
    protected readonly options: TabStatusPicker.Options<V>,
  ) {
    this.element = child(
      parent,
      "div",
      CLASSES.picker,
      ...(options.classes ?? []),
    );
    this.#tilesElement = child(this.element, "div", CLASSES.tiles);
    this.#tilesElement.setAttribute("role", "radiogroup");
    this.#caption = child(this.element, "div", CLASSES.caption);
    // The tiles carry the same words as their accessible names.
    this.#caption.setAttribute("aria-hidden", "true");
  }

  /** The chosen value, or `null` before the first `update`. */
  public get value(): V | null {
    return this.#value;
  }

  /**
   * Shows the options and the chosen one. Tiles are built once per list of
   * values; after that only what changed is written, so the focus stays.
   *
   * @param state the label of the group, its options and the chosen value
   */
  public update(state: TabStatusPicker.State<V>): void {
    const { options } = state;
    write(this.#tilesElement, "aria-label", state.label);
    if (
      options.length !== this.#tiles.length ||
      options.some(
        (option, index) => this.#tiles[index]?.value !== option.value,
      )
    ) {
      this.build(options.map((option) => option.value));
    }
    options.forEach((option, index) => {
      const tile = this.#tiles[index];
      if (tile) {
        this.fill(tile, option.label, state.describe(option.value));
      }
    });
    this.#value = state.value;
    this.mark();
  }

  public destroy(): void {
    this.#tiles.length = 0;
    this.element.remove();
  }

  protected build(values: readonly V[]): void {
    this.#tiles.length = 0;
    this.#tilesElement.replaceChildren();
    for (const value of values) {
      const element = child(this.#tilesElement, "button", CLASSES.tile),
        hostsElement = child(element, "span", CLASSES.tileHosts),
        textElement = child(element, "span", CLASSES.tileText),
        tile: Tile<V> = {
          element,
          focus: false,
          hosts: [],
          hostsElement,
          hover: false,
          label: "",
          textElement,
          value,
        };
      element.type = "button";
      element.setAttribute("role", "radio");
      element.dataset["value"] = value;
      element.addEventListener("click", () => {
        this.choose(tile);
      });
      element.addEventListener("keydown", (event) => {
        this.key(tile, event);
      });
      // The line under the tiles follows the pointer and the focus.
      element.addEventListener("pointerenter", () => {
        tile.hover = true;
        this.mark();
      });
      element.addEventListener("pointerleave", () => {
        tile.hover = false;
        this.mark();
      });
      element.addEventListener("focus", () => {
        tile.focus = true;
        this.mark();
      });
      element.addEventListener("blur", () => {
        tile.focus = false;
        this.mark();
      });
      this.#tiles.push(tile);
    }
  }

  protected fill(
    tile: Tile<V>,
    label: string,
    hosts: readonly TabStatusPreviewHost[],
  ): void {
    const { environment } = this.options;
    if (tile.label !== label) {
      tile.label = label;
      tile.element.setAttribute("aria-label", label);
      environment.setTooltip(tile.element, label);
      tile.textElement.textContent = label;
    }
    for (const extra of tile.hosts.splice(hosts.length)) {
      extra.element.remove();
    }
    hosts.forEach((host, index) => {
      let shown = tile.hosts[index];
      if (!shown) {
        shown = new PreviewHost(
          child(tile.hostsElement, "span", CLASSES.pickerHost),
          environment,
        );
        tile.hosts.push(shown);
      }
      shown.show(host);
    });
    // An unknown icon id leaves nothing to look at: the words stand in.
    tile.element.classList.toggle(
      CLASSES.tileTextOnly,
      tile.hosts.length === 0 || tile.hosts.some((host) => host.empty),
    );
  }

  /** Marks the chosen tile, moves the tab stop to it and says it in words. */
  protected mark(): void {
    const value = this.#value,
      chosen = this.#tiles.find((tile) => tile.value === value),
      stop = chosen ?? this.#tiles[0];
    for (const tile of this.#tiles) {
      write(tile.element, "aria-checked", String(tile === chosen));
      write(tile.element, "tabindex", tile === stop ? "0" : "-1");
    }
    // The pointer says more about where the eyes are than the focus does.
    const engaged =
        this.#tiles.find((tile) => tile.hover) ??
        this.#tiles.find((tile) => tile.focus),
      preview = engaged && engaged !== chosen ? engaged : null;
    writeText(this.#caption, (preview ?? chosen)?.label ?? "");
    this.#caption.classList.toggle(CLASSES.captionPreview, preview !== null);
  }

  protected choose(tile: Tile<V>): void {
    if (tile.value === this.#value) {
      return;
    }
    this.#value = tile.value;
    this.mark();
    this.options.onChange(tile.value);
  }

  protected key(tile: Tile<V>, event: KeyboardEvent): void {
    const target = this.target(tile, event.key);
    if (!target) {
      return;
    }
    // A button also turns Space and Enter into a click: one choice, not two.
    event.preventDefault();
    target.element.focus();
    this.choose(target);
  }

  /** The tile a key leads to from `tile`, or `null` for a key that is not ours. */
  protected target(tile: Tile<V>, key: string): Tile<V> | null {
    const tiles = this.#tiles,
      index = tiles.indexOf(tile),
      { length } = tiles,
      at = (position: number): Tile<V> | null =>
        tiles[(position + length) % length] ?? null;
    switch (key) {
      case " ":
      case "Enter":
        return tile;
      case "ArrowRight":
        return at(index + 1);
      case "ArrowLeft":
        return at(index - 1);
      case "ArrowDown":
        return this.across(tile, 1) ?? at(index + 1);
      case "ArrowUp":
        return this.across(tile, -1) ?? at(index - 1);
      case "Home":
        return at(0);
      case "End":
        return at(length - 1);
      default:
        return null;
    }
  }

  /**
   * The tile above or below in a wrapped grid: the nearest one in the next
   * row that way. `null` where there is no layout, or no such row; the
   * caller then steps to the neighbour, as a radio group does.
   */
  protected across(tile: Tile<V>, direction: -1 | 1): Tile<V> | null {
    const from = tile.element.getBoundingClientRect();
    if (from.width === 0) {
      return null;
    }
    let best: Tile<V> | null = null,
      bestRow = Infinity,
      bestColumn = Infinity;
    for (const other of this.#tiles) {
      const to = other.element.getBoundingClientRect(),
        row = (to.top - from.top) * direction,
        column = Math.abs(to.left - from.left);
      if (
        row > from.height / 2 &&
        (row < bestRow - 1 || (row < bestRow + 1 && column < bestColumn))
      ) {
        best = other;
        bestRow = row;
        bestColumn = column;
      }
    }
    return best;
  }
}
export namespace TabStatusPicker {
  export interface Options<V extends string> {
    readonly environment: TabStatusPreviewEnvironment;
    /** Called once when the user chooses another option than the current one. */
    readonly onChange: (value: V) => void;
    /** Extra classes for the picker element, for its layout. */
    readonly classes?: readonly string[];
  }
  export interface Option<V extends string> {
    readonly value: V;
    /** The option in words: its accessible name and its tooltip. */
    readonly label: string;
  }
  export interface State<V extends string> {
    /** The accessible name of the group. */
    readonly label: string;
    readonly options: readonly Option<V>[];
    readonly value: V;
    /** What a tile shows for an option. */
    readonly describe: (value: V) => readonly TabStatusPreviewHost[];
  }
}
