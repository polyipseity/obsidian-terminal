/**
 * The control of the "Program status" setting: small tiles on the line of
 * the setting's name, each showing the terminal tab icon as that option
 * draws it, with the option's name under it.
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
import { TAB_ICON_SIZE } from "./tab-icons.js";
import { TAB_STATUS_ATTRIBUTES, writeAttribute } from "./tab-status.js";

/** What the module needs from Obsidian. */
export interface TabStatusPreviewEnvironment {
  /** Obsidian's `setIcon`. May leave the element empty for an unknown id. */
  readonly setIcon: (element: HTMLElement, id: string) => void;
  /** Obsidian's `setTooltip`. */
  readonly setTooltip: (element: HTMLElement, text: string) => void;
}

/** The `data-terminal-*` attributes of a host, by their key in `TAB_STATUS_ATTRIBUTES`. A missing key removes the attribute. */
export interface TabStatusHostAttributes {
  readonly motion?: string | undefined;
  /** The icon's size in CSS pixels. */
  readonly size?: string | undefined;
  readonly status?: string | undefined;
}

/** The icon of a preview. */
export interface TabStatusPreviewHost {
  /** The id handed to `setIcon`. */
  readonly icon: string;
  readonly attributes: TabStatusHostAttributes;
}

const CLASSES = Object.freeze({
  host: "tts-host",
  hostIcon: "tts-host-icon",
  picker: "tts-pick",
  pickerHost: "tts-pick-host",
  tile: "tts-pick-tile",
  tileText: "tts-pick-text",
  tileTextOnly: "tts-pick-tile-text",
});

/**
 * What the tile of a Program status option shows: the icon a terminal tab
 * shows under that option, at the tab's size, carrying what its header
 * carries. None has no status, and its icon no marks; Still and Animated
 * show a working program, whose three dots stand still or move.
 *
 * @param value the option
 * @param icon the registered id of the icon a tab shows under the option
 *   (`tabIconId`)
 * @returns the host of the option's tile
 */
export function tabStatusOptionHost(
  value: Settings.TabStatus,
  icon: string,
): TabStatusPreviewHost {
  const size = String(TAB_ICON_SIZE);
  return {
    attributes:
      value === "none" ? { size } : { motion: value, size, status: "working" },
    icon,
  };
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
  // eslint-disable-next-line obsidianmd/prefer-create-el -- Plain DOM module: Obsidian's window helpers exist neither in the tests nor outside Obsidian
  const element = parent.ownerDocument.createElement(tag);
  element.classList.add(...classes);
  parent.append(element);
  return element;
}

function writeAttributes(
  element: Element,
  attributes: TabStatusHostAttributes,
): void {
  const names = TAB_STATUS_ATTRIBUTES;
  writeAttribute(element, names.motion, attributes.motion ?? null);
  writeAttribute(element, names.size, attributes.size ?? null);
  writeAttribute(element, names.status, attributes.status ?? null);
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

interface Tile<V extends string> {
  readonly value: V;
  readonly element: HTMLButtonElement;
  readonly host: PreviewHost;
  readonly textElement: HTMLElement;
  /** Mutable: `fill` writes it again whenever the option's name changes. */
  label: string;
}

/**
 * A radio group whose options are tiles: the option drawn on a real icon,
 * and its name under it.
 *
 * One tab stop; arrow keys move and choose, as do Home and End; Space and
 * Enter choose.
 */
export class TabStatusPicker<V extends string> {
  public readonly element: HTMLElement;
  readonly #tiles: Tile<V>[] = [];
  #value: V | null = null;

  public constructor(
    parent: HTMLElement,
    protected readonly options: TabStatusPicker.Options<V>,
  ) {
    this.element = child(parent, "div", CLASSES.picker);
    this.element.setAttribute("role", "radiogroup");
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
    writeAttribute(this.element, "aria-label", state.label);
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
    this.element.replaceChildren();
    for (const value of values) {
      const element = child(this.element, "button", CLASSES.tile),
        host = new PreviewHost(
          child(element, "span", CLASSES.pickerHost),
          this.options.environment,
        ),
        textElement = child(element, "span", CLASSES.tileText),
        tile: Tile<V> = { element, host, label: "", textElement, value };
      element.type = "button";
      element.setAttribute("role", "radio");
      element.dataset["value"] = value;
      // The words under the icon are the tile's name already.
      textElement.setAttribute("aria-hidden", "true");
      element.addEventListener("click", () => {
        this.choose(tile);
      });
      element.addEventListener("keydown", (event) => {
        this.key(tile, event);
      });
      this.#tiles.push(tile);
    }
  }

  protected fill(
    tile: Tile<V>,
    label: string,
    host: TabStatusPreviewHost,
  ): void {
    if (tile.label !== label) {
      tile.label = label;
      tile.element.setAttribute("aria-label", label);
      this.options.environment.setTooltip(tile.element, label);
      tile.textElement.textContent = label;
    }
    tile.host.show(host);
    // An unknown icon id leaves nothing to look at: the words stand alone.
    tile.element.classList.toggle(CLASSES.tileTextOnly, tile.host.empty);
  }

  /** Marks the chosen tile and moves the tab stop to it. */
  protected mark(): void {
    const value = this.#value,
      chosen = this.#tiles.find((tile) => tile.value === value),
      stop = chosen ?? this.#tiles[0];
    for (const tile of this.#tiles) {
      writeAttribute(tile.element, "aria-checked", String(tile === chosen));
      writeAttribute(tile.element, "tabindex", tile === stop ? "0" : "-1");
    }
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
      case "ArrowDown":
        return at(index + 1);
      case "ArrowLeft":
      case "ArrowUp":
        return at(index - 1);
      case "Home":
        return at(0);
      case "End":
        return at(length - 1);
      default:
        return null;
    }
  }
}
export namespace TabStatusPicker {
  export interface Options<V extends string> {
    readonly environment: TabStatusPreviewEnvironment;
    /** Called once when the user chooses another option than the current one. */
    readonly onChange: (value: V) => void;
  }
  export interface Option<V extends string> {
    readonly value: V;
    /** The option in words: its caption, its accessible name and its tooltip. */
    readonly label: string;
  }
  export interface State<V extends string> {
    /** The accessible name of the group. */
    readonly label: string;
    readonly options: readonly Option<V>[];
    readonly value: V;
    /** What a tile shows for an option. */
    readonly describe: (value: V) => TabStatusPreviewHost;
  }
}
