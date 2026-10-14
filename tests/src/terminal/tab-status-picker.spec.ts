/**
 * Unit tests for `src/terminal/tab-status-picker.ts` — the tiles of the
 * "Program status" setting.
 *
 * Covers:
 * - what the tile of each option shows: the tab icon at the tab's size, with
 *   the attributes a tab header carries under that option
 * - the tiles: order, captions, accessible names, tooltips, host attributes
 * - the chosen tile and the one tab stop following the value, also after a
 *   redraw with a value changed elsewhere
 * - choosing with the pointer and the keyboard, and the change callback
 * - the words standing alone where an icon cannot be drawn
 * - every element belonging to the parent's document, not the global one
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TabStatusPicker,
  type TabStatusPreviewEnvironment,
  type TabStatusPreviewHost,
  tabStatusOptionHost,
} from "../../../src/terminal/tab-status-picker.js";
import type { Settings } from "../../../src/settings-data.js";
import { TAB_ICON_SIZE } from "../../../src/terminal/tab-icons.js";

/** The options in the order the setting shows them. */
const OPTIONS: readonly Settings.TabStatus[] = ["none", "still", "animated"];
const NAMES: Readonly<Record<Settings.TabStatus, string>> = {
  animated: "Animated",
  none: "None",
  still: "Still",
};
const ICON = "terminal:tab-bezel";
const MISSING = "icon:missing";

// The names are binding (the stylesheet and the tab header use them), so
// they are spelt out here rather than read from the module that defines them.
const MOTION = "data-terminal-motion";
const SIZE = "data-terminal-size";
const STATUS = "data-terminal-status";

interface Environment extends TabStatusPreviewEnvironment {
  readonly setIcon: ReturnType<
    typeof vi.fn<TabStatusPreviewEnvironment["setIcon"]>
  >;
  readonly setTooltip: ReturnType<
    typeof vi.fn<TabStatusPreviewEnvironment["setTooltip"]>
  >;
}

/** Obsidian, stubbed. `setIcon` draws nothing for `MISSING`. */
function environment(): Environment {
  return {
    setIcon: vi.fn<TabStatusPreviewEnvironment["setIcon"]>((element, id) => {
      if (id !== MISSING) {
        const drawn = element.ownerDocument.createElement("i");
        drawn.dataset["icon"] = id;
        element.replaceChildren(drawn);
      }
    }),
    setTooltip: vi.fn<TabStatusPreviewEnvironment["setTooltip"]>(),
  };
}

const describeOption = (value: Settings.TabStatus): TabStatusPreviewHost =>
  tabStatusOptionHost(value, ICON);

interface Fixture {
  readonly doc: Document;
  readonly parent: HTMLElement;
  readonly env: Environment;
  readonly onChange: ReturnType<
    typeof vi.fn<(value: Settings.TabStatus) => void>
  >;
  readonly picker: TabStatusPicker<Settings.TabStatus>;
  readonly show: (
    value: Settings.TabStatus,
    describe?: (value: Settings.TabStatus) => TabStatusPreviewHost,
  ) => void;
  readonly tiles: () => HTMLElement[];
  readonly tile: (value: Settings.TabStatus) => HTMLElement;
  readonly checked: () => (string | undefined)[];
}

/** A picker in a second document, so that a use of the global one shows. */
function fixture(value: Settings.TabStatus = "still"): Fixture {
  const doc = document.implementation.createHTMLDocument("settings"),
    parent = doc.body.appendChild(doc.createElement("div")),
    env = environment(),
    onChange = vi.fn<(value: Settings.TabStatus) => void>(),
    picker = new TabStatusPicker<Settings.TabStatus>(parent, {
      environment: env,
      onChange,
    }),
    show: Fixture["show"] = (value0, describe = describeOption) => {
      picker.update({
        describe,
        label: "Program status",
        options: OPTIONS.map((option) => ({
          label: NAMES[option],
          value: option,
        })),
        value: value0,
      });
    },
    tiles = (): HTMLElement[] => [
      ...picker.element.querySelectorAll<HTMLElement>('[role="radio"]'),
    ],
    tile = (value0: Settings.TabStatus): HTMLElement => {
      const found = tiles().find((each) => each.dataset["value"] === value0);
      if (!found) {
        throw new Error(value0);
      }
      return found;
    };
  show(value);
  return {
    checked: () =>
      tiles()
        .filter((each) => each.getAttribute("aria-checked") === "true")
        .map((each) => each.dataset["value"]),
    doc,
    env,
    onChange,
    parent,
    picker,
    show,
    tile,
    tiles,
  };
}

function press(element: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  element.dispatchEvent(event);
  return event;
}

function host(tile: Element): HTMLElement {
  const found = tile.querySelector<HTMLElement>(".tts-host");
  if (!found) {
    throw new Error("host");
  }
  return found;
}

function caption(tile: Element): HTMLElement {
  const found = tile.querySelector<HTMLElement>(".tts-pick-text");
  if (!found) {
    throw new Error("caption");
  }
  return found;
}

/** The attributes of a host other than its class, by name. */
function attributes(element: Element): Readonly<Record<string, string>> {
  return Object.fromEntries(
    element
      .getAttributeNames()
      .filter((name) => name !== "class")
      .map((name) => [name, element.getAttribute(name) ?? ""]),
  );
}

describe("tabStatusOptionHost", () => {
  it("draws every option at the tab's size of 22 pixels", () => {
    expect(TAB_ICON_SIZE).toBe(22);
    for (const value of OPTIONS) {
      expect(tabStatusOptionHost(value, ICON).attributes.size).toBe("22");
    }
  });

  it("shows None as a tab header without a status: the icon at its size, and nothing else", () => {
    expect(tabStatusOptionHost("none", ICON)).toEqual({
      attributes: { size: "22" },
      icon: ICON,
    });
  });

  it.each(["still", "animated"] as const)(
    "shows %s as a working program whose dots move that way",
    (value) => {
      expect(tabStatusOptionHost(value, ICON)).toEqual({
        attributes: { motion: value, size: "22", status: "working" },
        icon: ICON,
      });
    },
  );

  it("draws every option on the icon it is given", () => {
    for (const value of OPTIONS) {
      expect(tabStatusOptionHost(value, "other").icon).toBe("other");
    }
  });
});

describe("TabStatusPicker", () => {
  let made: Fixture;
  beforeEach(() => {
    made = fixture();
  });

  it("draws one tile per option, in the given order", () => {
    expect(made.tiles().map((tile) => tile.dataset["value"])).toEqual(OPTIONS);
  });

  it("puts the icon over its option's name on every tile", () => {
    for (const value of OPTIONS) {
      const tile = made.tile(value);
      expect(Array.from(tile.children, (each) => each.className)).toEqual([
        "tts-pick-host tts-host",
        "tts-pick-text",
      ]);
      expect(caption(tile).textContent).toBe(NAMES[value]);
    }
  });

  it("names every tile with its option's text and gives it a tooltip", () => {
    expect(made.tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual(
      ["None", "Still", "Animated"],
    );
    for (const value of OPTIONS) {
      expect(made.env.setTooltip).toHaveBeenCalledWith(
        made.tile(value),
        NAMES[value],
      );
    }
  });

  it("hides the words under an icon from assistive technology, which has the tile's name", () => {
    for (const tile of made.tiles()) {
      expect(caption(tile).getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("is a labelled radio group of buttons that do not submit", () => {
    const group = made.picker.element;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Program status");
    expect(group.classList.contains("tts-pick")).toBe(true);
    expect(made.tiles().map((tile) => tile.tagName)).toEqual([
      "BUTTON",
      "BUTTON",
      "BUTTON",
    ]);
    expect(made.tiles().map((tile) => tile.getAttribute("type"))).toEqual([
      "button",
      "button",
      "button",
    ]);
    expect(group.parentElement).toBe(made.parent);
  });

  it("draws None on the icon at its size only", () => {
    expect(attributes(host(made.tile("none")))).toEqual({ [SIZE]: "22" });
  });

  it("draws Still on a working tab whose dots stand still", () => {
    expect(attributes(host(made.tile("still")))).toEqual({
      [MOTION]: "still",
      [SIZE]: "22",
      [STATUS]: "working",
    });
  });

  it("draws Animated on a working tab whose dots move", () => {
    expect(attributes(host(made.tile("animated")))).toEqual({
      [MOTION]: "animated",
      [SIZE]: "22",
      [STATUS]: "working",
    });
  });

  it("draws the icon it is given in every tile", () => {
    for (const value of OPTIONS) {
      const icon = host(made.tile(value)).querySelector(".tts-host-icon");
      expect(made.env.setIcon).toHaveBeenCalledWith(icon, ICON);
      expect(icon?.childElementCount).toBe(1);
    }
  });

  it("marks the current value and only it", () => {
    expect(made.checked()).toEqual(["still"]);
    expect(
      made.tiles().map((tile) => tile.getAttribute("aria-checked")),
    ).toEqual(["false", "true", "false"]);
  });

  it("has one tab stop, on the chosen tile", () => {
    expect(made.tiles().map((tile) => tile.getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1",
    ]);
    made.show("animated");
    expect(made.tiles().map((tile) => tile.getAttribute("tabindex"))).toEqual([
      "-1",
      "-1",
      "0",
    ]);
  });

  describe("on a redraw", () => {
    it("follows a value changed from elsewhere, without reporting it", () => {
      made.show("none");
      expect(made.checked()).toEqual(["none"]);
      expect(made.picker.value).toBe("none");
      expect(made.onChange).not.toHaveBeenCalled();
    });

    it("keeps its tiles, so the focus stays", () => {
      const before = made.tiles();
      made.show("animated");
      expect(made.tiles()).toEqual(before);
    });

    it("sets an icon again only when its id changes", () => {
      made.env.setIcon.mockClear();
      made.show("animated");
      expect(made.env.setIcon).not.toHaveBeenCalled();
      made.show("animated", (value) => tabStatusOptionHost(value, "other"));
      expect(made.env.setIcon).toHaveBeenCalledTimes(OPTIONS.length);
    });

    it("does not touch a host whose description is the same", () => {
      const shown = host(made.tile("animated")),
        set = vi.spyOn(shown, "setAttribute"),
        remove = vi.spyOn(shown, "removeAttribute");
      made.show("none");
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it("removes the attributes a new description no longer has", () => {
      made.show("still", () => tabStatusOptionHost("none", ICON));
      for (const tile of made.tiles()) {
        expect(attributes(host(tile))).toEqual({ [SIZE]: "22" });
      }
    });

    it("takes new texts without rebuilding", () => {
      const before = made.tiles();
      made.env.setTooltip.mockClear();
      made.picker.update({
        describe: describeOption,
        label: "Programmstatus",
        options: OPTIONS.map((value) => ({ label: `${value}!`, value })),
        value: "still",
      });
      expect(made.tiles()).toEqual(before);
      expect(made.picker.element.getAttribute("aria-label")).toBe(
        "Programmstatus",
      );
      expect(made.tile("none").getAttribute("aria-label")).toBe("none!");
      expect(caption(made.tile("none")).textContent).toBe("none!");
      expect(made.env.setTooltip).toHaveBeenCalledWith(
        made.tile("none"),
        "none!",
      );
    });

    it("does not set a tooltip again for an unchanged text", () => {
      made.env.setTooltip.mockClear();
      made.show("animated");
      expect(made.env.setTooltip).not.toHaveBeenCalled();
    });

    it("builds anew for another list of options", () => {
      made.picker.update({
        describe: describeOption,
        label: "Program status",
        options: [{ label: "None", value: "none" }],
        value: "none",
      });
      expect(made.tiles().map((tile) => tile.dataset["value"])).toEqual([
        "none",
      ]);
    });
  });

  it("chooses the clicked tile", () => {
    made.tile("animated").click();
    expect(made.checked()).toEqual(["animated"]);
    expect(made.picker.value).toBe("animated");
    expect(made.onChange).toHaveBeenCalledExactlyOnceWith("animated");
  });

  it.each([" ", "Enter"])("chooses the tile on which %j is pressed", (key) => {
    const event = press(made.tile("none"), key);
    expect(made.checked()).toEqual(["none"]);
    expect(made.onChange).toHaveBeenCalledExactlyOnceWith("none");
    // Otherwise the button's own click would choose a second time.
    expect(event.defaultPrevented).toBe(true);
  });

  it.each<readonly [string, Settings.TabStatus, Settings.TabStatus]>([
    ["ArrowRight", "still", "animated"],
    ["ArrowDown", "still", "animated"],
    ["ArrowLeft", "still", "none"],
    ["ArrowUp", "still", "none"],
    ["ArrowRight", "animated", "none"],
    ["ArrowDown", "animated", "none"],
    ["ArrowLeft", "none", "animated"],
    ["ArrowUp", "none", "animated"],
    ["Home", "animated", "none"],
    ["End", "none", "animated"],
  ])("%s on %s moves to and chooses %s", (key, from, to) => {
    made.show(from);
    const focused = vi.fn();
    made.tile(to).addEventListener("focus", focused);
    const event = press(made.tile(from), key);
    expect(made.checked()).toEqual([to]);
    expect(made.tile(to).getAttribute("tabindex")).toBe("0");
    expect(focused).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(made.onChange).toHaveBeenCalledExactlyOnceWith(to);
  });

  it("leaves other keys alone", () => {
    const event = press(made.tile("still"), "a");
    expect(event.defaultPrevented).toBe(false);
    expect(made.onChange).not.toHaveBeenCalled();
  });

  it("does not report the current tile being chosen again", () => {
    made.tile("still").click();
    press(made.tile("still"), "Enter");
    expect(made.onChange).not.toHaveBeenCalled();
  });

  it("reports once per change", () => {
    made.tile("animated").click();
    made.tile("animated").click();
    made.tile("none").click();
    expect(made.onChange.mock.calls).toEqual([["animated"], ["none"]]);
  });

  it("shows the option's words alone where the icon stays empty", () => {
    made.show("still", (value) =>
      tabStatusOptionHost(value, value === "none" ? MISSING : ICON),
    );
    expect(made.tile("none").classList.contains("tts-pick-tile-text")).toBe(
      true,
    );
    expect(caption(made.tile("none")).textContent).toBe("None");
    expect(made.tile("still").classList.contains("tts-pick-tile-text")).toBe(
      false,
    );
  });

  it("builds every element in the parent's document", () => {
    const all = [
      made.picker.element,
      ...made.picker.element.querySelectorAll("*"),
    ];
    expect(all.length).toBeGreaterThan(OPTIONS.length * 4);
    for (const element of all) {
      expect(element.ownerDocument).toBe(made.doc);
    }
    expect(document.querySelector(".tts-pick")).toBeNull();
  });

  it("removes itself when destroyed", () => {
    made.picker.destroy();
    expect(made.parent.childElementCount).toBe(0);
  });

  // A value saved by another version, or not yet fixed, is no option here.
  describe("when the chosen value is not among its options", () => {
    beforeEach(() => {
      made.picker.update({
        describe: describeOption,
        label: "Program status",
        options: [
          { label: NAMES.none, value: "none" },
          { label: NAMES.still, value: "still" },
        ],
        value: "animated",
      });
    });

    it("marks no tile as chosen and keeps the value it was given", () => {
      expect(
        made.tiles().map((tile) => tile.getAttribute("aria-checked")),
      ).toEqual(["false", "false"]);
      expect(made.picker.value).toBe("animated");
      expect(made.onChange).not.toHaveBeenCalled();
    });

    it("keeps its one tab stop, on the first tile", () => {
      expect(made.tiles().map((tile) => tile.getAttribute("tabindex"))).toEqual(
        ["0", "-1"],
      );
    });

    it("takes a click on any of its tiles as a change", () => {
      made.tile("still").click();
      expect(made.onChange).toHaveBeenCalledExactlyOnceWith("still");
      expect(made.checked()).toEqual(["still"]);
    });
  });
});
