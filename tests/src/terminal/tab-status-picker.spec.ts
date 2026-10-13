/**
 * Unit tests for `src/terminal/tab-status-picker.ts` — the preview strip and
 * the option pickers of the "Tab status" settings.
 *
 * Covers:
 * - the tiles of a picker: order, accessible names, tooltips, host attributes
 * - the chosen tile, the tab stop and the line of words following the value
 * - choosing with the pointer and the keyboard, and the change callback
 * - the words standing in for an icon that cannot be drawn
 * - the strip's five tabs following the look
 * - the attributes of a preview host, for every state
 * - what each of the three pickers shows for the current look
 * - every element belonging to the parent's document, not the global one
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TAB_STATUS_PICKER_HOSTS,
  TAB_STATUS_PREVIEW_STATES,
  TabStatusPicker,
  type TabStatusPreviewEnvironment,
  type TabStatusPreviewHost,
  TabStatusStrip,
  tabStatusHostAttributes,
  tabStatusPreviewAttributes,
} from "../../../src/terminal/tab-status-picker.js";
import {
  TAB_STATUS_ATTRIBUTES,
  type TabStatusLook,
  TabStatusPresenter,
} from "../../../src/terminal/tab-status.js";
import { Settings } from "../../../src/settings-data.js";

const LOOK: TabStatusLook = {
  animation: "none",
  set: "bezel",
  size: 18,
};

type Fruit = "apple" | "banana" | "cherry";
const FRUITS: readonly Fruit[] = ["apple", "banana", "cherry"];
const NAMES: Readonly<Record<Fruit, string>> = {
  apple: "An apple",
  banana: "A banana",
  cherry: "A cherry",
};
const MISSING = "icon:missing";

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

/** A working tab; the fruit rides on the animation attribute to tell the hosts apart. */
function hostOf(fruit: Fruit): readonly TabStatusPreviewHost[] {
  return [{ attributes: { animation: fruit, status: "working" }, icon: fruit }];
}

interface Fixture {
  readonly doc: Document;
  readonly parent: HTMLElement;
  readonly env: Environment;
  readonly onChange: ReturnType<typeof vi.fn<(value: Fruit) => void>>;
  readonly picker: TabStatusPicker<Fruit>;
  readonly show: (
    value: Fruit,
    describe?: (value: Fruit) => readonly TabStatusPreviewHost[],
  ) => void;
  readonly tiles: () => HTMLElement[];
  readonly tile: (value: Fruit) => HTMLElement;
  readonly checked: () => (string | undefined)[];
  readonly caption: () => HTMLElement;
}

/** A picker in a second document, so that a use of the global one shows. */
function fixture(value: Fruit = "banana"): Fixture {
  const doc = document.implementation.createHTMLDocument("settings"),
    parent = doc.body.appendChild(doc.createElement("div")),
    env = environment(),
    onChange = vi.fn<(value: Fruit) => void>(),
    picker = new TabStatusPicker<Fruit>(parent, {
      classes: ["extra"],
      environment: env,
      onChange,
    }),
    show: Fixture["show"] = (value0, describe = hostOf) => {
      picker.update({
        describe,
        label: "Fruit",
        options: FRUITS.map((fruit) => ({ label: NAMES[fruit], value: fruit })),
        value: value0,
      });
    },
    tiles = (): HTMLElement[] => [
      ...picker.element.querySelectorAll<HTMLElement>('[role="radio"]'),
    ],
    tile = (value0: Fruit): HTMLElement => {
      const found = tiles().find((each) => each.dataset["value"] === value0);
      if (!found) {
        throw new Error(value0);
      }
      return found;
    },
    caption = (): HTMLElement => {
      const found =
        picker.element.querySelector<HTMLElement>(".tts-pick-caption");
      if (!found) {
        throw new Error("caption");
      }
      return found;
    };
  show(value);
  return {
    caption,
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

describe("TabStatusPicker", () => {
  let made: Fixture;
  beforeEach(() => {
    made = fixture();
  });

  it("draws one tile per option, in the given order", () => {
    expect(made.tiles().map((tile) => tile.dataset["value"])).toEqual(FRUITS);
  });

  it("names every tile with its option's text and gives it a tooltip", () => {
    expect(made.tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual(
      ["An apple", "A banana", "A cherry"],
    );
    for (const fruit of FRUITS) {
      expect(made.env.setTooltip).toHaveBeenCalledWith(
        made.tile(fruit),
        NAMES[fruit],
      );
    }
  });

  it("is a labelled radio group of buttons that do not submit", () => {
    const group = made.picker.element.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("Fruit");
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
    expect(made.picker.element.classList.contains("extra")).toBe(true);
  });

  it("draws each option on a preview host with its attributes and icon", () => {
    for (const fruit of FRUITS) {
      const shown = host(made.tile(fruit)),
        icon = shown.querySelector(".tts-host-icon");
      expect(shown.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe(fruit);
      expect(shown.getAttribute(TAB_STATUS_ATTRIBUTES.status)).toBe("working");
      // Only what was described: no size, so the tile shows its icon enlarged.
      expect(shown.getAttributeNames().sort()).toEqual([
        "class",
        TAB_STATUS_ATTRIBUTES.animation,
        TAB_STATUS_ATTRIBUTES.status,
      ]);
      expect(made.env.setIcon).toHaveBeenCalledWith(icon, fruit);
      expect(icon?.childElementCount).toBe(1);
    }
  });

  it("draws one host per described icon and drops those no longer described", () => {
    made.show("banana", (fruit) => [...hostOf(fruit), ...hostOf(fruit)]);
    expect(made.tile("apple").querySelectorAll(".tts-host")).toHaveLength(2);
    made.show("banana");
    expect(made.tile("apple").querySelectorAll(".tts-host")).toHaveLength(1);
  });

  it("marks the current value and only it", () => {
    expect(made.checked()).toEqual(["banana"]);
    expect(
      made.tiles().map((tile) => tile.getAttribute("aria-checked")),
    ).toEqual(["false", "true", "false"]);
  });

  it("follows a value changed from elsewhere", () => {
    made.show("cherry");
    expect(made.checked()).toEqual(["cherry"]);
    expect(made.picker.value).toBe("cherry");
    expect(made.onChange).not.toHaveBeenCalled();
  });

  it("keeps its tiles when only the value changes", () => {
    const before = made.tiles();
    made.show("cherry");
    expect(made.tiles()).toEqual(before);
  });

  it("sets an icon again only when its id changes", () => {
    made.env.setIcon.mockClear();
    made.show("cherry");
    expect(made.env.setIcon).not.toHaveBeenCalled();
    made.show("cherry", () => [{ attributes: {}, icon: "other" }]);
    expect(made.env.setIcon).toHaveBeenCalledTimes(FRUITS.length);
  });

  it("removes an attribute the new description no longer has", () => {
    made.show("banana", (fruit) => [{ attributes: {}, icon: fruit }]);
    expect(host(made.tile("apple")).getAttributeNames()).toEqual(["class"]);
  });

  it("writes all three attributes of a description on its host, and no other", () => {
    made.show("banana", (fruit) => [
      {
        attributes: {
          animation: "loop",
          size: "22",
          status: "working",
        },
        icon: fruit,
      },
    ]);
    const shown = host(made.tile("apple"));
    expect(shown.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("loop");
    expect(shown.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe("22");
    expect(shown.getAttribute(TAB_STATUS_ATTRIBUTES.status)).toBe("working");
    expect(shown.getAttributeNames().sort()).toEqual([
      "class",
      TAB_STATUS_ATTRIBUTES.animation,
      TAB_STATUS_ATTRIBUTES.size,
      TAB_STATUS_ATTRIBUTES.status,
    ]);
  });

  it("writes no quiet attribute, not for a description that still has one", () => {
    // What a description of an earlier build held; the grey badge needs nothing.
    const earlier: TabStatusPreviewHost["attributes"] & {
      readonly quiet: string;
    } = { quiet: "badge", status: "idle" };
    made.show("banana", (fruit) => [{ attributes: earlier, icon: fruit }]);
    for (const tile of made.tiles()) {
      expect(host(tile).getAttributeNames().sort()).toEqual([
        "class",
        TAB_STATUS_ATTRIBUTES.status,
      ]);
      expect(host(tile).hasAttribute("data-terminal-quiet")).toBe(false);
    }
  });

  it("does not touch a host whose description is the same", () => {
    const shown = host(made.tile("apple")),
      set = vi.spyOn(shown, "setAttribute"),
      remove = vi.spyOn(shown, "removeAttribute");
    made.show("cherry");
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("has one tab stop, on the chosen tile", () => {
    expect(made.tiles().map((tile) => tile.getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1",
    ]);
    made.show("apple");
    expect(made.tiles().map((tile) => tile.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
  });

  it("says the chosen option in words under the tiles", () => {
    expect(made.caption().textContent).toBe("A banana");
    made.show("apple");
    expect(made.caption().textContent).toBe("An apple");
  });

  it("says the option under the pointer while it is there", () => {
    made.tile("cherry").dispatchEvent(new Event("pointerenter"));
    expect(made.caption().textContent).toBe("A cherry");
    expect(made.caption().classList.contains("tts-pick-caption-preview")).toBe(
      true,
    );
    made.tile("cherry").dispatchEvent(new Event("pointerleave"));
    expect(made.caption().textContent).toBe("A banana");
    expect(made.caption().classList.contains("tts-pick-caption-preview")).toBe(
      false,
    );
  });

  it("says the option that has the focus while it has it", () => {
    made.tile("apple").dispatchEvent(new Event("focus"));
    expect(made.caption().textContent).toBe("An apple");
    expect(made.caption().classList.contains("tts-pick-caption-preview")).toBe(
      true,
    );
    made.tile("apple").dispatchEvent(new Event("blur"));
    expect(made.caption().textContent).toBe("A banana");
    expect(made.caption().classList.contains("tts-pick-caption-preview")).toBe(
      false,
    );
  });

  it("says the option under the pointer rather than the focused one", () => {
    made.tile("apple").dispatchEvent(new Event("focus"));
    made.tile("cherry").dispatchEvent(new Event("pointerenter"));
    expect(made.caption().textContent).toBe("A cherry");
    made.tile("cherry").dispatchEvent(new Event("pointerleave"));
    expect(made.caption().textContent).toBe("An apple");
  });

  it("does not mark the words as a preview while the pointer is on the chosen tile", () => {
    made.tile("banana").dispatchEvent(new Event("pointerenter"));
    expect(made.caption().textContent).toBe("A banana");
    expect(made.caption().classList.contains("tts-pick-caption-preview")).toBe(
      false,
    );
  });

  it("only changes the words, not the hosts, under the pointer and the focus", () => {
    const before = made.picker.element.querySelector(
      '[role="radiogroup"]',
    )?.innerHTML;
    made.tile("apple").dispatchEvent(new Event("pointerenter"));
    made.tile("apple").dispatchEvent(new Event("focus"));
    expect(
      made.picker.element.querySelector('[role="radiogroup"]')?.innerHTML,
    ).toBe(before);
  });

  it("hides the words under the tiles from assistive technology, which has the tiles' names", () => {
    expect(made.caption().getAttribute("aria-hidden")).toBe("true");
  });

  it("chooses the clicked tile", () => {
    made.tile("cherry").click();
    expect(made.checked()).toEqual(["cherry"]);
    expect(made.onChange).toHaveBeenCalledExactlyOnceWith("cherry");
  });

  it.each([" ", "Enter"])("chooses the tile on which %j is pressed", (key) => {
    const event = press(made.tile("apple"), key);
    expect(made.checked()).toEqual(["apple"]);
    expect(made.onChange).toHaveBeenCalledExactlyOnceWith("apple");
    // Otherwise the button's own click would choose a second time.
    expect(event.defaultPrevented).toBe(true);
  });

  it.each<readonly [string, Fruit, Fruit]>([
    ["ArrowRight", "banana", "cherry"],
    ["ArrowDown", "banana", "cherry"],
    ["ArrowLeft", "banana", "apple"],
    ["ArrowUp", "banana", "apple"],
    ["ArrowRight", "cherry", "apple"],
    ["ArrowLeft", "apple", "cherry"],
    ["Home", "cherry", "apple"],
    ["End", "apple", "cherry"],
  ])("%s on %s moves to and chooses %s", (key, from, to) => {
    made.show(from);
    const focused = vi.fn();
    made.tile(to).addEventListener("focus", focused);
    press(made.tile(from), key);
    expect(made.checked()).toEqual([to]);
    expect(made.tile(to).getAttribute("tabindex")).toBe("0");
    expect(focused).toHaveBeenCalled();
    expect(made.onChange).toHaveBeenCalledExactlyOnceWith(to);
  });

  it("leaves other keys alone", () => {
    const event = press(made.tile("banana"), "a");
    expect(event.defaultPrevented).toBe(false);
    expect(made.onChange).not.toHaveBeenCalled();
  });

  it("does not report the current tile being chosen again", () => {
    made.tile("banana").click();
    press(made.tile("banana"), "Enter");
    expect(made.onChange).not.toHaveBeenCalled();
  });

  it("reports once per change", () => {
    made.tile("cherry").click();
    made.tile("cherry").click();
    made.tile("apple").click();
    expect(made.onChange.mock.calls).toEqual([["cherry"], ["apple"]]);
  });

  it("shows the option's text where the icon stays empty", () => {
    made.show("banana", (fruit) => [
      { attributes: {}, icon: fruit === "apple" ? MISSING : fruit },
    ]);
    expect(made.tile("apple").classList.contains("tts-pick-tile-text")).toBe(
      true,
    );
    expect(
      made.tile("apple").querySelector(".tts-pick-text")?.textContent,
    ).toBe("An apple");
    expect(made.tile("banana").classList.contains("tts-pick-tile-text")).toBe(
      false,
    );
  });

  it("takes new texts without rebuilding", () => {
    const before = made.tiles();
    made.env.setTooltip.mockClear();
    made.picker.update({
      describe: hostOf,
      label: "Obst",
      options: FRUITS.map((fruit) => ({ label: `${fruit}!`, value: fruit })),
      value: "banana",
    });
    expect(made.tiles()).toEqual(before);
    expect(made.tile("apple").getAttribute("aria-label")).toBe("apple!");
    expect(made.env.setTooltip).toHaveBeenCalledWith(
      made.tile("apple"),
      "apple!",
    );
    expect(made.caption().textContent).toBe("banana!");
  });

  it("does not set a tooltip again for an unchanged text", () => {
    made.env.setTooltip.mockClear();
    made.show("cherry");
    expect(made.env.setTooltip).not.toHaveBeenCalled();
  });

  it("builds anew for another list of options", () => {
    made.picker.update({
      describe: hostOf,
      label: "Fruit",
      options: [{ label: "A cherry", value: "cherry" }],
      value: "cherry",
    });
    expect(made.tiles().map((tile) => tile.dataset["value"])).toEqual([
      "cherry",
    ]);
  });

  it("builds every element in the parent's document", () => {
    const all = [
      made.picker.element,
      ...made.picker.element.querySelectorAll("*"),
    ];
    expect(all.length).toBeGreaterThan(FRUITS.length * 4);
    for (const element of all) {
      expect(element.ownerDocument).toBe(made.doc);
    }
    expect(made.picker.element.parentElement).toBe(made.parent);
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
        describe: hostOf,
        label: "Fruit",
        options: [
          { label: NAMES.apple, value: "apple" },
          { label: NAMES.banana, value: "banana" },
        ],
        value: "cherry",
      });
    });

    it("marks no tile as chosen and keeps the value it was given", () => {
      expect(
        made.tiles().map((tile) => tile.getAttribute("aria-checked")),
      ).toEqual(["false", "false"]);
      expect(made.picker.value).toBe("cherry");
      expect(made.onChange).not.toHaveBeenCalled();
    });

    it("keeps its one tab stop, on the first tile", () => {
      expect(made.tiles().map((tile) => tile.getAttribute("tabindex"))).toEqual(
        ["0", "-1"],
      );
    });

    it("says nothing under the tiles until the pointer is on one", () => {
      expect(made.caption().textContent).toBe("");
      expect(
        made.caption().classList.contains("tts-pick-caption-preview"),
      ).toBe(false);
      made.tile("apple").dispatchEvent(new Event("pointerenter"));
      expect(made.caption().textContent).toBe("An apple");
      expect(
        made.caption().classList.contains("tts-pick-caption-preview"),
      ).toBe(true);
    });

    it("takes a click on any of its tiles as a change", () => {
      made.tile("banana").click();
      expect(made.onChange).toHaveBeenCalledExactlyOnceWith("banana");
      expect(made.checked()).toEqual(["banana"]);
    });

    it("marks a tile again once the value is one of its own", () => {
      made.show("apple");
      expect(made.checked()).toEqual(["apple"]);
      expect(made.caption().textContent).toBe("An apple");
    });
  });
});

describe("TabStatusStrip", () => {
  const CAPTIONS = ["No status", "Working", "Finished", "Needs you", "Error"];

  function strip(): {
    readonly doc: Document;
    readonly env: Environment;
    readonly made: TabStatusStrip;
    readonly show: (look: TabStatusLook) => void;
    readonly tabs: () => HTMLElement[];
  } {
    const doc = document.implementation.createHTMLDocument("settings"),
      env = environment(),
      made = new TabStatusStrip(doc.body, env),
      show = (look: TabStatusLook): void => {
        made.update({
          label: "Preview",
          tabs: TAB_STATUS_PREVIEW_STATES.map((state, index) => ({
            caption: CAPTIONS[index] ?? "",
            current: index === 0,
            host: {
              attributes: tabStatusPreviewAttributes(look, state),
              icon: `tab-${look.set}`,
            },
          })),
        });
      };
    show(LOOK);
    return {
      doc,
      env,
      made,
      show,
      tabs: () => [...made.element.querySelectorAll<HTMLElement>(".tts-host")],
    };
  }

  it("shows the five states, each a preview host with its words", () => {
    const { made, tabs } = strip();
    expect(made.element.getAttribute("aria-label")).toBe("Preview");
    expect(
      tabs().map((tab) => tab.getAttribute(TAB_STATUS_ATTRIBUTES.status)),
    ).toEqual([null, "working", "done", "blocked", "error"]);
    expect(
      tabs().map((tab) => tab.querySelector(".tts-strip-title")?.textContent),
    ).toEqual(CAPTIONS);
    for (const tab of tabs()) {
      expect(tab.querySelector(".tts-host-icon")?.childElementCount).toBe(1);
    }
  });

  it("puts the icon before the words, as a tab does", () => {
    const { tabs } = strip();
    expect(
      [...(tabs()[0]?.children ?? [])].map((child) => child.className),
    ).toEqual(["tts-host-icon", "tts-strip-title"]);
  });

  it("draws every tab with the current look", () => {
    const { env, tabs } = strip();
    for (const tab of tabs()) {
      expect(tab.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("none");
      expect(tab.hasAttribute("data-terminal-quiet")).toBe(false);
      // A piece of the tab bar: the icons are as large as on a tab.
      expect(tab.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe("18");
      // The set shows as the icon; no attribute says it.
      expect(env.setIcon).toHaveBeenCalledWith(
        tab.querySelector(".tts-host-icon"),
        "tab-bezel",
      );
      expect(
        tab.getAttributeNames().filter((name) => name.startsWith("data-")),
      ).toEqual(
        expect.arrayContaining([
          TAB_STATUS_ATTRIBUTES.animation,
          TAB_STATUS_ATTRIBUTES.size,
        ]),
      );
      expect(
        tab
          .getAttributeNames()
          .filter(
            (name) =>
              name.startsWith("data-") &&
              !Object.values<string>(TAB_STATUS_ATTRIBUTES).includes(name),
          ),
      ).toEqual([]);
    }
  });

  it("draws only the first tab as the one the user is on", () => {
    const { tabs } = strip();
    expect(tabs().map((tab) => tab.classList.contains("is-active"))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("follows a changed look, keeping its tabs", () => {
    const { env, show, tabs } = strip(),
      before = tabs();
    env.setIcon.mockClear();
    show({
      animation: "loop",
      set: "tile",
      size: 22,
    });
    expect(tabs()).toEqual(before);
    for (const tab of tabs()) {
      expect(tab.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("loop");
      expect(tab.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe("22");
    }
    // No look changes what the tabs report: the finished one is unread.
    expect(
      tabs().map((tab) => tab.getAttribute(TAB_STATUS_ATTRIBUTES.status)),
    ).toEqual([null, "working", "done", "blocked", "error"]);
    expect(env.setIcon).toHaveBeenCalledTimes(5);
    expect(env.setIcon).toHaveBeenCalledWith(expect.anything(), "tab-tile");
  });

  it("does not touch the icons when the look is the same", () => {
    const { env, show } = strip();
    env.setIcon.mockClear();
    show(LOOK);
    expect(env.setIcon).not.toHaveBeenCalled();
  });

  it("does not touch a tab when the look is the same", () => {
    const { show, tabs } = strip(),
      spies = tabs().flatMap((tab) => [
        vi.spyOn(tab, "setAttribute"),
        vi.spyOn(tab, "removeAttribute"),
      ]);
    show(LOOK);
    // The strip toggles its "current" class on every update, and happy-dom
    // writes `class` for a toggle that changes nothing; the attributes of
    // the look are what must stay untouched.
    for (const spy of spies) {
      expect(spy.mock.calls.filter(([name]) => name !== "class")).toEqual([]);
    }
  });

  it("is a labelled group", () => {
    const { made } = strip();
    expect(made.element.getAttribute("role")).toBe("group");
  });

  it("drops tabs that are no longer asked for", () => {
    const { made, tabs } = strip();
    made.update({ label: "Preview", tabs: [] });
    expect(tabs()).toHaveLength(0);
  });

  it("builds every element in the parent's document and removes itself", () => {
    const { doc, made } = strip();
    for (const element of [
      made.element,
      ...made.element.querySelectorAll("*"),
    ]) {
      expect(element.ownerDocument).toBe(doc);
    }
    expect(document.querySelector(".tts-strip")).toBeNull();
    made.destroy();
    expect(doc.body.childElementCount).toBe(0);
  });
});

describe("tabStatusHostAttributes", () => {
  it.each(["idle", "working", "done", "seen", "blocked", "error"] as const)(
    "carries the animation and the status %s, and nothing else",
    (status) => {
      expect(tabStatusHostAttributes(LOOK, status)).toEqual({
        animation: "none",
        status,
      });
    },
  );

  it("follows the look", () => {
    expect(
      tabStatusHostAttributes({ ...LOOK, animation: "loop" }, "working"),
    ).toEqual({ animation: "loop", status: "working" });
  });

  it("has no status for a tab without a report", () => {
    expect(tabStatusHostAttributes(LOOK, null)).toEqual({
      animation: "none",
    });
  });

  it("leaves the size out, so that a tile can show its icon enlarged", () => {
    expect(tabStatusHostAttributes(LOOK, "done")).not.toHaveProperty("size");
  });

  it.each(["done", "seen"] as const)(
    "shows %s as it is given: which of the two a finish is, is the caller's to say",
    (status) => {
      for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
        expect(
          tabStatusHostAttributes({ ...LOOK, animation }, status).status,
        ).toBe(status);
      }
    },
  );

  it("names only attributes a tab header has", () => {
    expect(
      Object.keys(TAB_STATUS_ATTRIBUTES).sort(),
      // The set is not among them: a host shows it by its icon.
    ).toEqual(["animation", "size", "status"]);
    for (const key of Object.keys(tabStatusHostAttributes(LOOK, "error"))) {
      expect(TAB_STATUS_ATTRIBUTES).toHaveProperty(key);
    }
  });
});

describe("tabStatusPreviewAttributes", () => {
  it("has the five tabs in the order the strip shows them", () => {
    expect(TAB_STATUS_PREVIEW_STATES).toEqual([
      "none",
      "working",
      "done",
      "blocked",
      "error",
    ]);
  });

  it.each([
    ["none", undefined],
    ["working", "working"],
    // Unread: the tabs after the first are ones the user is not looking at.
    ["done", "done"],
    ["blocked", "blocked"],
    ["error", "error"],
  ] as const)(
    "shows %s as the presenter would on a tab nobody looks at",
    (state, status) => {
      const look: TabStatusLook = {
          ...LOOK,
          animation: "loop",
          size: 22,
        },
        attributes = tabStatusPreviewAttributes(look, state);
      expect(attributes).toEqual({
        animation: "loop",
        // A piece of the tab bar: the icons are as large as on a tab.
        size: "22",
        ...(status === undefined ? {} : { status }),
      });
      // What a tab the user is not looking at carries for the same report.
      const header = document.createElement("div"),
        presenter = new TabStatusPresenter({
          header: () => header,
          look: () => look,
          lookedAt: () => false,
        });
      presenter.report(state === "none" ? null : state);
      expect(
        Object.fromEntries(
          Object.entries(TAB_STATUS_ATTRIBUTES).flatMap(([key, name]) => {
            const value = header.getAttribute(name);
            return value === null ? [] : [[key, value]];
          }),
        ),
      ).toEqual(attributes);
    },
  );

  it("shows the finished tab as done under every look, never as seen", () => {
    for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
      for (const set of Settings.TAB_ICON_SETS) {
        for (const size of Settings.TAB_ICON_SIZES) {
          expect(
            tabStatusPreviewAttributes({ animation, set, size }, "done").status,
          ).toBe("done");
        }
      }
    }
  });
});

describe("TAB_STATUS_PICKER_HOSTS", () => {
  const icon = vi.fn((set: string): string => `tab-${set}`),
    CURRENT: TabStatusLook = {
      animation: "loop",
      set: "tile",
      size: 22,
    };

  it("has a picker for the set, the size and the animation, and none for the grey badge", () => {
    expect(Object.keys(TAB_STATUS_PICKER_HOSTS).sort()).toEqual([
      "animation",
      "set",
      "size",
    ]);
  });

  it.each(Settings.TAB_ICON_SETS)(
    "shows the icon set %s at rest, on its own icon",
    (set) => {
      const [host0, ...rest] = TAB_STATUS_PICKER_HOSTS.set(CURRENT, set, icon);
      expect(rest).toHaveLength(0);
      expect(host0?.icon).toBe(`tab-${set}`);
      expect(host0?.attributes).not.toHaveProperty("status");
      // Enlarged by the tile, and following the other settings.
      expect(host0?.attributes).not.toHaveProperty("size");
      expect(host0?.attributes).toEqual({ animation: "loop" });
    },
  );

  it.each(Settings.TAB_ICON_SIZES)(
    "shows the size %i on the current set at rest, as large as on a tab",
    (size) => {
      const [host0, ...rest] = TAB_STATUS_PICKER_HOSTS.size(
        CURRENT,
        size,
        icon,
      );
      expect(rest).toHaveLength(0);
      expect(host0?.icon).toBe("tab-tile");
      expect(host0?.attributes.size).toBe(String(size));
      expect(host0?.attributes).not.toHaveProperty("status");
    },
  );

  it.each(Settings.TAB_STATUS_ANIMATIONS)(
    "shows the animation %s on a working tab of the current set",
    (animation) => {
      const [host0, ...rest] = TAB_STATUS_PICKER_HOSTS.animation(
        // The other value is the current one: the tile shows its own.
        { ...CURRENT, animation: animation === "loop" ? "none" : "loop" },
        animation,
        icon,
      );
      expect(rest).toHaveLength(0);
      expect(host0?.icon).toBe("tab-tile");
      expect(host0?.attributes).toEqual({
        animation,
        status: "working",
      });
    },
  );

  it("leaves the size out of every tile but those of the size picker", () => {
    for (const hosts of [
      TAB_STATUS_PICKER_HOSTS.set(CURRENT, "tile", icon),
      TAB_STATUS_PICKER_HOSTS.animation(CURRENT, "loop", icon),
    ]) {
      expect(hosts.length).toBeGreaterThan(0);
      for (const each of hosts) {
        expect(each.attributes).not.toHaveProperty("size");
      }
    }
  });

  it("describes a host by its icon and its attributes, and nothing else", () => {
    for (const hosts of [
      TAB_STATUS_PICKER_HOSTS.set(CURRENT, "tile", icon),
      TAB_STATUS_PICKER_HOSTS.size(CURRENT, 12, icon),
      TAB_STATUS_PICKER_HOSTS.animation(CURRENT, "loop", icon),
    ]) {
      for (const each of hosts) {
        expect(Object.keys(each).sort()).toEqual(["attributes", "icon"]);
      }
    }
  });
});
