/**
 * Unit tests for `src/terminal/tab-status.ts` — the status a terminal tab shows.
 *
 * Covers:
 * - what is displayed for each reported state, seen and unseen
 * - what counts as unread: a finished program until the user looks, whatever
 *   the settings
 * - the attributes written on the header, and nothing besides them; the size
 *   is not the presenter's
 * - the pop of a new state that asks for the user, and the slide of a new
 *   title, under Animated only: restarted, ended and cleaned up
 * - idempotent writes and cleanup
 * - the gate on Program status, the size and the icon written on a tab that
 *   has no presenter
 * - the window focus listener that goes with a tab into another window
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../../../src/settings-data.js";
import { TAB_ICON_SIZE } from "../../../src/terminal/tab-icons.js";
import {
  TAB_STATUS_ATTRIBUTES,
  TAB_STATUS_KEYFRAMES,
  TAB_STATUS_TITLE_COOLDOWN,
  TAB_STATUS_TRANSIENT_TIMEOUTS,
  type TabStatusLook,
  TabStatusPresenter,
  TransientAttribute,
  isTabStatusShown,
  needsAttention,
  onWindowFocus,
  tabStatusLook,
  whileTabStatusShown,
  writeAttribute,
  writeTabIcon,
  writeTabIconSize,
} from "../../../src/terminal/tab-status.js";

const LOOK: TabStatusLook = { motion: "still" },
  ANIMATED: TabStatusLook = { motion: "animated" };

/** Attributes of earlier designs. Nothing writes them any more. */
const REMOVED_ATTRIBUTES = [
  "data-terminal-animation",
  "data-terminal-set",
  "data-terminal-marks",
  "data-terminal-palette",
  "data-terminal-tint",
  "data-terminal-working",
  "data-terminal-unread",
  // Idle and seen always have the grey badge: nothing asks for it.
  "data-terminal-quiet",
];

interface Fixture {
  readonly header: HTMLElement;
  readonly presenter: TabStatusPresenter;
  readonly lookedAt: ReturnType<typeof vi.fn<() => boolean>>;
  readonly look: ReturnType<typeof vi.fn<() => TabStatusLook>>;
}

function fixture(look: TabStatusLook = LOOK, lookedAt = false): Fixture {
  const header = document.createElement("div"),
    lookedAt0 = vi.fn<() => boolean>().mockReturnValue(lookedAt),
    look0 = vi.fn<() => TabStatusLook>().mockReturnValue(look),
    presenter = new TabStatusPresenter({
      header: () => header,
      look: look0,
      lookedAt: lookedAt0,
    });
  return { header, look: look0, lookedAt: lookedAt0, presenter };
}

function status(header: Element): string | null {
  return header.getAttribute(TAB_STATUS_ATTRIBUTES.status);
}

function pop(header: Element): string | null {
  return header.getAttribute(TAB_STATUS_ATTRIBUTES.pop);
}

function sliding(header: Element): boolean {
  return header.hasAttribute(TAB_STATUS_ATTRIBUTES.title);
}

/** The end of an animation, as the browser announces it from inside the header. */
function animationEnd(target: Element, animationName: string): void {
  target.dispatchEvent(
    Object.assign(new Event("animationend", { bubbles: true }), {
      animationName,
    }),
  );
}

describe("TAB_STATUS_ATTRIBUTES", () => {
  it("names the five attributes the stylesheet reads", () => {
    expect(TAB_STATUS_ATTRIBUTES).toEqual({
      motion: "data-terminal-motion",
      pop: "data-terminal-pop",
      size: "data-terminal-size",
      status: "data-terminal-status",
      title: "data-terminal-title-change",
    });
  });
});

describe("tabStatusLook", () => {
  it.each([
    ["none", "still"],
    ["still", "still"],
    ["animated", "animated"],
  ] as const)("gives %s the motion %s", (tabStatus, motion) => {
    expect(tabStatusLook({ tabStatus })).toEqual({ motion });
  });

  it("covers every Program status", () => {
    for (const tabStatus of Settings.TAB_STATUSES) {
      expect(["still", "animated"]).toContain(
        tabStatusLook({ tabStatus }).motion,
      );
    }
  });
});

describe("isTabStatusShown", () => {
  it.each([
    ["none", false],
    ["still", true],
    ["animated", true],
  ] as const)("answers for %s: %s", (tabStatus, shown) => {
    expect(isTabStatusShown({ tabStatus })).toBe(shown);
  });
});

describe("whileTabStatusShown", () => {
  /** A settings source that announces a change of Program status. */
  function settingsOf(initial: Settings.TabStatus) {
    let value: Pick<Settings, "tabStatus"> = { tabStatus: initial };
    const listeners: (() => void)[] = [];
    return {
      get value() {
        return value;
      },
      onMutate<V>(
        accessor: (settings: Pick<Settings, "tabStatus">) => V,
        callback: (cur: V) => unknown,
      ): () => void {
        let prev = accessor(value);
        const listener = (): void => {
          const cur = accessor(value);
          if (cur !== prev) {
            prev = cur;
            callback(cur);
          }
        };
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
      set(tabStatus: Settings.TabStatus): void {
        value = { tabStatus };
        for (const listener of [...listeners]) {
          listener();
        }
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts nothing under None, starts at Still or Animated, and stops at None", () => {
    const settings = settingsOf("none"),
      stop = vi.fn(),
      start = vi.fn(() => stop);
    whileTabStatusShown(settings, start);
    expect(start).not.toHaveBeenCalled();
    settings.set("still");
    expect(start).toHaveBeenCalledOnce();
    settings.set("none");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("neither stops nor starts between Still and Animated", () => {
    const settings = settingsOf("animated"),
      stop = vi.fn(),
      start = vi.fn(() => stop),
      dispose = whileTabStatusShown(settings, start);
    expect(start).toHaveBeenCalledOnce();
    settings.set("still");
    settings.set("animated");
    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    dispose();
    expect(stop).toHaveBeenCalledOnce();
    settings.set("none");
    settings.set("still");
    expect(start).toHaveBeenCalledOnce();
  });

  it("logs an error of start under the feature's name, and the change goes on", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {}),
      settings = settingsOf("none"),
      failure = new Error("start failed");
    whileTabStatusShown(settings, () => {
      throw failure;
    });
    expect(() => {
      settings.set("still");
    }).not.toThrow();
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      "Program status on tabs:",
      failure,
    );
  });
});

describe("writeAttribute", () => {
  it("sets a value, replaces it and takes it back", () => {
    const element = document.createElement("div");
    writeAttribute(element, "data-x", "one");
    expect(element.getAttribute("data-x")).toBe("one");
    writeAttribute(element, "data-x", "two");
    expect(element.getAttribute("data-x")).toBe("two");
    writeAttribute(element, "data-x", null);
    expect(element.hasAttribute("data-x")).toBe(false);
  });

  it("leaves the element alone when nothing changes", () => {
    const element = document.createElement("div"),
      set = vi.spyOn(element, "setAttribute"),
      remove = vi.spyOn(element, "removeAttribute");
    writeAttribute(element, "data-x", null);
    expect(remove).not.toHaveBeenCalled();
    writeAttribute(element, "data-x", "one");
    writeAttribute(element, "data-x", "one");
    expect(set).toHaveBeenCalledOnce();
  });
});

describe("needsAttention", () => {
  it.each([
    ["idle", false],
    ["working", false],
    ["done", true],
    ["blocked", true],
    ["error", true],
  ] as const)("answers for %s: %s", (state, expected) => {
    expect(needsAttention(state)).toBe(expected);
  });
});

describe("TabStatusPresenter", () => {
  it("shows nothing before the program reports", () => {
    const { header, presenter } = fixture();
    presenter.render();
    expect(presenter.display).toBeNull();
    expect(presenter.unread).toBe(false);
    expect(header.hasAttribute(TAB_STATUS_ATTRIBUTES.status)).toBe(false);
  });

  it.each(["idle", "working"] as const)(
    "shows %s, which never counts as unread",
    (state) => {
      const { header, presenter } = fixture();
      presenter.report(state);
      expect(status(header)).toBe(state);
      expect(presenter.display).toBe(state);
      expect(presenter.unread).toBe(false);
      presenter.look();
      expect(status(header)).toBe(state);
      expect(presenter.unread).toBe(false);
    },
  );

  it.each(["done", "blocked", "error"] as const)(
    "shows %s and counts it as unread when it arrives unseen",
    (state) => {
      const { header, presenter } = fixture();
      presenter.report(state);
      expect(status(header)).toBe(state);
      expect(presenter.display).toBe(state);
      expect(presenter.unread).toBe(true);
    },
  );

  it("shows a finished program as seen when the user is already looking", () => {
    const { header, presenter } = fixture(LOOK, true);
    presenter.report("done");
    expect(status(header)).toBe("seen");
    expect(presenter.display).toBe("seen");
    expect(presenter.unread).toBe(false);
  });

  it("shows a finished program as done until the user looks, and as seen afterwards", () => {
    const { header, presenter } = fixture();
    presenter.report("done");
    expect(status(header)).toBe("done");
    presenter.look();
    expect(status(header)).toBe("seen");
    expect(presenter.display).toBe("seen");
    expect(presenter.unread).toBe(false);
  });

  it.each(["blocked", "error"] as const)(
    "keeps %s on the tab after the user looks, no longer unread",
    (state) => {
      const { header, presenter } = fixture();
      presenter.report(state);
      presenter.look();
      expect(status(header)).toBe(state);
      expect(presenter.unread).toBe(false);
    },
  );

  it.each(["blocked", "error"] as const)(
    "shows %s as itself when the user is already looking",
    (state) => {
      const { header, presenter } = fixture(LOOK, true);
      presenter.report(state);
      expect(status(header)).toBe(state);
      expect(presenter.unread).toBe(false);
    },
  );

  it("treats a second finish as new", () => {
    const { header, presenter } = fixture();
    presenter.report("done");
    presenter.look();
    presenter.report("working");
    presenter.report("done");
    expect(status(header)).toBe("done");
    expect(presenter.unread).toBe(true);
  });

  it("is no longer unread when the program goes back to work", () => {
    const { header, presenter } = fixture();
    presenter.report("blocked");
    presenter.report("working");
    expect(status(header)).toBe("working");
    expect(presenter.unread).toBe(false);
  });

  it("removes the status when the program clears it", () => {
    const { header, presenter } = fixture();
    presenter.report("error");
    presenter.report(null);
    expect(header.hasAttribute(TAB_STATUS_ATTRIBUTES.status)).toBe(false);
    expect(presenter.display).toBeNull();
    expect(presenter.unread).toBe(false);
  });

  it("has no setting in the look that could hide an unseen finish or the grey badge", () => {
    // `satisfies` fails the type check if the look grows a key again.
    expect(
      Object.keys(LOOK satisfies Record<keyof TabStatusLook, unknown>).sort(),
    ).toEqual(["motion"]);
  });

  it.each([LOOK, ANIMATED])(
    "shows an unseen finish as done under any look (%j), and as seen only once the user looks",
    (other) => {
      const { header, look, presenter } = fixture(other);
      presenter.report("done");
      expect(status(header)).toBe("done");
      expect(presenter.display).toBe("done");
      expect(presenter.unread).toBe(true);
      // No change of the look stands in for the user's look.
      look.mockReturnValue(other === LOOK ? ANIMATED : LOOK);
      presenter.render();
      expect(status(header)).toBe("done");
      expect(presenter.unread).toBe(true);
      presenter.look();
      expect(status(header)).toBe("seen");
      expect(presenter.display).toBe("seen");
      expect(presenter.unread).toBe(false);
    },
  );

  it("keeps a seen finish seen when the settings change", () => {
    const { header, look, presenter } = fixture();
    presenter.report("done");
    presenter.look();
    look.mockReturnValue(ANIMATED);
    presenter.render();
    expect(status(header)).toBe("seen");
    expect(presenter.unread).toBe(false);
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.motion)).toBe("animated");
  });

  it.each(["blocked", "error"] as const)(
    "does not turn a seen %s unread again when the settings change",
    (state) => {
      const { header, presenter } = fixture();
      presenter.report(state);
      presenter.look();
      presenter.render();
      expect(status(header)).toBe(state);
      expect(presenter.unread).toBe(false);
    },
  );

  it.each([
    [LOOK, "still"],
    [ANIMATED, "animated"],
  ] as const)("writes the motion of the look %j", (look, motion) => {
    const { header, presenter } = fixture(look);
    presenter.render();
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.motion)).toBe(motion);
  });

  it("follows a changed look on the next render", () => {
    const { header, look, presenter } = fixture();
    presenter.render();
    look.mockReturnValue(ANIMATED);
    presenter.render();
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.motion)).toBe("animated");
    look.mockReturnValue(LOOK);
    presenter.render();
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.motion)).toBe("still");
  });

  it.each(["idle", "working", "done", "blocked", "error"] as const)(
    "writes the status and the motion for %s, and nothing else at rest",
    (state) => {
      const { header, presenter } = fixture();
      presenter.report(state);
      // Only these two, and no inline style: a timer that wrote a count
      // here four times a second was what made the motion jerk. The size is
      // not the presenter's.
      expect(header.getAttributeNames().sort()).toEqual([
        "data-terminal-motion",
        "data-terminal-status",
      ]);
      for (const name of REMOVED_ATTRIBUTES) {
        expect(header.hasAttribute(name)).toBe(false);
      }
      presenter.look();
      expect(header.getAttributeNames().sort()).toEqual([
        "data-terminal-motion",
        "data-terminal-status",
      ]);
    },
  );

  it("leaves the attributes of others on the header alone, the size too", () => {
    const { header, presenter } = fixture(ANIMATED);
    header.setAttribute("data-type", "terminal:terminal");
    header.setAttribute("aria-label", "Terminal");
    writeTabIconSize(header);
    presenter.report("error");
    presenter.titleChanged();
    presenter.clear();
    expect(header.getAttributeNames()).toEqual([
      "data-type",
      "aria-label",
      "data-terminal-size",
    ]);
  });

  it("does not touch the header when nothing changed", () => {
    const { header, presenter } = fixture();
    presenter.report("working");
    const set = vi.spyOn(header, "setAttribute"),
      remove = vi.spyOn(header, "removeAttribute");
    presenter.report("working");
    presenter.render();
    presenter.look();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("writes only the attribute that changed", () => {
    const { header, presenter } = fixture();
    presenter.report("working");
    const set = vi.spyOn(header, "setAttribute"),
      remove = vi.spyOn(header, "removeAttribute");
    presenter.report("done");
    expect(set).toHaveBeenCalledExactlyOnceWith(
      TAB_STATUS_ATTRIBUTES.status,
      "done",
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes every attribute it wrote on clear and forgets the state", () => {
    const { header, presenter } = fixture();
    presenter.report("blocked");
    presenter.clear();
    expect(header.getAttributeNames()).toEqual([]);
    expect(presenter.display).toBeNull();
    expect(presenter.unread).toBe(false);
  });

  it("leaves continuous motion to the stylesheet: a working tab gets the motion and nothing that counts", () => {
    const { header, look, presenter } = fixture(ANIMATED);
    presenter.report("working");
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.motion)).toBe("animated");
    expect(status(header)).toBe("working");
    expect(header.hasAttribute("style")).toBe(false);
    look.mockReturnValue(LOOK);
    presenter.render();
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.motion)).toBe("still");
  });

  it("reads the header anew on every write", () => {
    const first = document.createElement("div"),
      second = document.createElement("div"),
      header = vi.fn<() => Element | null>().mockReturnValue(first),
      presenter = new TabStatusPresenter({
        header,
        look: () => LOOK,
        lookedAt: () => false,
      });
    presenter.report("error");
    header.mockReturnValue(second);
    presenter.render();
    expect(status(second)).toBe("error");
    expect(second.getAttributeNames().sort()).toEqual(
      first.getAttributeNames().sort(),
    );
  });

  it("does nothing while there is no header", () => {
    const presenter = new TabStatusPresenter({
      header: () => null,
      look: () => ANIMATED,
      lookedAt: () => false,
    });
    expect(() => {
      presenter.report("done");
      presenter.look();
      presenter.render();
      presenter.titleChanged();
      presenter.clear();
    }).not.toThrow();
  });

  describe("a new state that asks for the user, under Animated", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(["done", "blocked", "error"] as const)(
      "pops %s in, with the state as the value, and takes it back when the animation ends",
      (state) => {
        const { header, presenter } = fixture(ANIMATED);
        presenter.report("working");
        expect(pop(header)).toBeNull();
        presenter.report(state);
        expect(pop(header)).toBe(state);
        expect(status(header)).toBe(state);
        // Another animation ending is not this one.
        animationEnd(header, TAB_STATUS_KEYFRAMES.title);
        animationEnd(header, "tts-dots");
        expect(pop(header)).toBe(state);
        // The mark inside the header ends its pop; the event bubbles.
        const mark = header.appendChild(document.createElement("i"));
        animationEnd(mark, TAB_STATUS_KEYFRAMES.pop);
        expect(pop(header)).toBeNull();
        // Nothing waits any more.
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it("takes it back after a while where no animation runs", () => {
      const { header, presenter } = fixture(ANIMATED);
      presenter.report("error");
      expect(pop(header)).toBe("error");
      vi.advanceTimersByTime(TAB_STATUS_TRANSIENT_TIMEOUTS.pop - 1);
      expect(pop(header)).toBe("error");
      vi.advanceTimersByTime(1);
      expect(pop(header)).toBeNull();
      expect(status(header)).toBe("error");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("pops in only when the state shown changes into one: not for a repeat, a look or a render", () => {
      const { header, presenter } = fixture(ANIMATED),
        set = vi.spyOn(header, "setAttribute");
      presenter.report("blocked");
      vi.runAllTimers();
      set.mockClear();
      presenter.report("blocked");
      presenter.render();
      presenter.look();
      expect(set).not.toHaveBeenCalled();
      expect(pop(header)).toBeNull();
    });

    it("does not pop for idle, working or seen, nor for a finish the user already sees", () => {
      const { header, lookedAt, presenter } = fixture(ANIMATED);
      for (const state of ["idle", "working"] as const) {
        presenter.report(state);
        expect(pop(header), state).toBeNull();
      }
      presenter.report("done");
      vi.runAllTimers();
      // Done, then seen: the badge with the check does not pop.
      presenter.look();
      expect(status(header)).toBe("seen");
      expect(pop(header)).toBeNull();
      presenter.report("working");
      lookedAt.mockReturnValue(true);
      presenter.report("done");
      expect(status(header)).toBe("seen");
      expect(pop(header)).toBeNull();
    });

    it("pops a second finish in again, and a change between two that ask for the user", () => {
      const { header, presenter } = fixture(ANIMATED);
      presenter.report("done");
      vi.runAllTimers();
      presenter.look();
      presenter.report("working");
      presenter.report("done");
      expect(pop(header)).toBe("done");
      vi.runAllTimers();
      presenter.report("error");
      expect(pop(header)).toBe("error");
    });

    it("starts over when another arrives while one plays: taken off, a layout, set again", () => {
      const { header, presenter } = fixture(ANIMATED),
        steps: string[] = [];
      presenter.report("blocked");
      vi.advanceTimersByTime(TAB_STATUS_TRANSIENT_TIMEOUTS.pop - 100);
      vi.spyOn(header, "removeAttribute").mockImplementation(function (
        this: Element,
        name,
      ) {
        steps.push(`remove ${name}`);
        Element.prototype.removeAttribute.call(this, name);
      });
      vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => {
        steps.push("layout");
        return new DOMRect();
      });
      vi.spyOn(header, "setAttribute").mockImplementation(function (
        this: Element,
        name,
        value,
      ) {
        steps.push(`set ${name}=${value}`);
        Element.prototype.setAttribute.call(this, name, value);
      });
      presenter.report("error");
      expect(steps).toEqual([
        "set data-terminal-status=error",
        "remove data-terminal-pop",
        "layout",
        "set data-terminal-pop=error",
      ]);
      // A whole new while: the timer of the first is gone.
      vi.advanceTimersByTime(TAB_STATUS_TRANSIENT_TIMEOUTS.pop - 1);
      expect(pop(header)).toBe("error");
      vi.advanceTimersByTime(1);
      expect(pop(header)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops the pop when another mark is shown before it ends", () => {
      const { header, presenter } = fixture(ANIMATED);
      presenter.report("done");
      expect(pop(header)).toBe("done");
      presenter.report("working");
      expect(pop(header)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("never pops under Still, and stops one that plays when the look turns still", () => {
      const { header, look, presenter } = fixture(LOOK),
        set = vi.spyOn(header, "setAttribute");
      for (const state of ["done", "working", "blocked", "error"] as const) {
        presenter.report(state);
        expect(pop(header), state).toBeNull();
      }
      expect(
        set.mock.calls.filter(([name]) => name === TAB_STATUS_ATTRIBUTES.pop),
      ).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      look.mockReturnValue(ANIMATED);
      presenter.report("working");
      presenter.report("done");
      expect(pop(header)).toBe("done");
      look.mockReturnValue(LOOK);
      presenter.render();
      expect(pop(header)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not pop what was already shown when the look turns animated", () => {
      const { header, look, presenter } = fixture(LOOK);
      presenter.report("error");
      look.mockReturnValue(ANIMATED);
      presenter.render();
      expect(pop(header)).toBeNull();
    });

    it("takes a pop back on clear, with its timer and its listener", () => {
      const { header, presenter } = fixture(ANIMATED),
        unlisten = vi.spyOn(header, "removeEventListener");
      presenter.report("blocked");
      presenter.clear();
      expect(pop(header)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(unlisten).toHaveBeenCalledWith(
        "animationend",
        expect.any(Function),
      );
      // And a report after it is news again.
      presenter.report("blocked");
      expect(pop(header)).toBe("blocked");
    });

    it.each(["blocked", "error"] as const)(
      "pops %s in again when the program asks once more after the user has seen it, while the user is elsewhere",
      (state) => {
        const { header, lookedAt, presenter } = fixture(ANIMATED);
        presenter.report(state);
        vi.runAllTimers();
        presenter.look();
        expect(presenter.unread).toBe(false);
        expect(pop(header)).toBeNull();
        lookedAt.mockReturnValue(false);
        presenter.report(state);
        // The same mark, unread again: it asks for the user, so it pops.
        expect(status(header)).toBe(state);
        expect(presenter.unread).toBe(true);
        expect(pop(header)).toBe(state);
      },
    );

    it("pops once for the same state reported twice while unread", () => {
      const { header, presenter } = fixture(ANIMATED),
        set = vi.spyOn(header, "setAttribute");
      presenter.report("blocked");
      presenter.report("blocked");
      vi.runAllTimers();
      presenter.report("blocked");
      expect(
        set.mock.calls.filter(([name]) => name === TAB_STATUS_ATTRIBUTES.pop),
      ).toEqual([[TAB_STATUS_ATTRIBUTES.pop, "blocked"]]);
      expect(pop(header)).toBeNull();
    });

    it("does not pop again for a report the user sees as it arrives", () => {
      const { header, lookedAt, presenter } = fixture(ANIMATED);
      presenter.report("blocked");
      vi.runAllTimers();
      presenter.look();
      lookedAt.mockReturnValue(true);
      presenter.report("blocked");
      expect(pop(header)).toBeNull();
    });

    it("never pops a repeat under Still, nor later when the look turns animated", () => {
      const { header, look, lookedAt, presenter } = fixture(LOOK),
        set = vi.spyOn(header, "setAttribute");
      presenter.report("blocked");
      presenter.look();
      lookedAt.mockReturnValue(false);
      presenter.report("blocked");
      expect(presenter.unread).toBe(true);
      look.mockReturnValue(ANIMATED);
      presenter.render();
      expect(
        set.mock.calls.filter(([name]) => name === TAB_STATUS_ATTRIBUTES.pop),
      ).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("drops the pop of a repeat that arrives while there is no header, rather than play it later", () => {
      const header = document.createElement("div"),
        there = vi.fn<() => Element | null>().mockReturnValue(header),
        lookedAt = vi.fn<() => boolean>().mockReturnValue(false),
        presenter = new TabStatusPresenter({
          header: there,
          look: () => ANIMATED,
          lookedAt,
        });
      presenter.report("error");
      vi.runAllTimers();
      presenter.look();
      there.mockReturnValue(null);
      presenter.report("error");
      there.mockReturnValue(header);
      presenter.render();
      expect(status(header)).toBe("error");
      expect(pop(header)).toBeNull();
    });
  });

  describe("a new title, under Animated", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("slides it in, and takes the attribute back when the title's animation ends", () => {
      const { header, presenter } = fixture(ANIMATED),
        title = header.appendChild(document.createElement("div"));
      title.className = "workspace-tab-header-inner-title";
      presenter.titleChanged();
      expect(sliding(header)).toBe(true);
      animationEnd(title, TAB_STATUS_KEYFRAMES.pop);
      expect(sliding(header)).toBe(true);
      animationEnd(title, TAB_STATUS_KEYFRAMES.title);
      expect(sliding(header)).toBe(false);
      // Only the cooldown waits, and nothing once it is over.
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(TAB_STATUS_TITLE_COOLDOWN);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("takes it back after a while where no animation runs", () => {
      const { header, presenter } = fixture(ANIMATED);
      presenter.titleChanged();
      vi.advanceTimersByTime(TAB_STATUS_TRANSIENT_TIMEOUTS.title - 1);
      expect(sliding(header)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(sliding(header)).toBe(false);
    });

    it("does not start over when the title changes again while it slides: no layout, the same end", () => {
      const { header, presenter } = fixture(ANIMATED),
        layout = vi.spyOn(header, "getBoundingClientRect"),
        set = vi.spyOn(header, "setAttribute");
      presenter.titleChanged();
      vi.advanceTimersByTime(TAB_STATUS_TRANSIENT_TIMEOUTS.title - 50);
      presenter.titleChanged();
      expect(layout).not.toHaveBeenCalled();
      expect(set).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(49);
      expect(sliding(header)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(sliding(header)).toBe(false);
    });

    it("slides once for titles 100 ms apart, and again only after the cooldown", () => {
      const { header, presenter } = fixture(ANIMATED),
        set = vi.spyOn(header, "setAttribute"),
        slides = (): number =>
          set.mock.calls.filter(
            ([name]) => name === TAB_STATUS_ATTRIBUTES.title,
          ).length;
      expect(TAB_STATUS_TITLE_COOLDOWN).toBeGreaterThan(
        TAB_STATUS_TRANSIENT_TIMEOUTS.title,
      );
      // A program that renames its terminal ten times a second.
      for (
        let elapsed = 0;
        elapsed < TAB_STATUS_TITLE_COOLDOWN;
        elapsed += 100
      ) {
        presenter.titleChanged();
        vi.advanceTimersByTime(100);
      }
      expect(slides()).toBe(1);
      expect(sliding(header)).toBe(false);
      // The cooldown is over: the next title slides in.
      presenter.titleChanged();
      expect(slides()).toBe(2);
      expect(sliding(header)).toBe(true);
    });

    it("never slides under Still, stops when the look turns still, and goes on clear", () => {
      const { header, look, presenter } = fixture(LOOK);
      presenter.titleChanged();
      expect(sliding(header)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      look.mockReturnValue(ANIMATED);
      presenter.titleChanged();
      expect(sliding(header)).toBe(true);
      look.mockReturnValue(LOOK);
      presenter.render();
      expect(sliding(header)).toBe(false);
      look.mockReturnValue(ANIMATED);
      vi.advanceTimersByTime(TAB_STATUS_TITLE_COOLDOWN);
      presenter.titleChanged();
      expect(sliding(header)).toBe(true);
      presenter.clear();
      expect(sliding(header)).toBe(false);
      // The cooldown goes too.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves the status and the pop to themselves", () => {
      const { header, presenter } = fixture(ANIMATED);
      presenter.report("done");
      presenter.titleChanged();
      animationEnd(header, TAB_STATUS_KEYFRAMES.title);
      expect(pop(header)).toBe("done");
      expect(status(header)).toBe("done");
    });
  });
});

describe("TransientAttribute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has a value only while it plays", () => {
    const element = document.createElement("div"),
      transient = new TransientAttribute("data-x", "x", 100);
    expect(transient.value).toBeNull();
    transient.play(element, "one");
    expect(transient.value).toBe("one");
    expect(element.getAttribute("data-x")).toBe("one");
    transient.stop();
    expect(transient.value).toBeNull();
    expect(element.hasAttribute("data-x")).toBe(false);
    // Again: nothing left to do.
    expect(() => {
      transient.stop();
    }).not.toThrow();
  });

  it("moves to another element without a layout of the first", () => {
    const first = document.createElement("div"),
      second = document.createElement("div"),
      layout = vi.spyOn(first, "getBoundingClientRect"),
      transient = new TransientAttribute("data-x", "x", 100);
    transient.play(first, "one");
    transient.play(second, "two");
    expect(first.hasAttribute("data-x")).toBe(false);
    expect(second.getAttribute("data-x")).toBe("two");
    expect(layout).not.toHaveBeenCalled();
    // The first no longer listens.
    animationEnd(first, "x");
    expect(second.getAttribute("data-x")).toBe("two");
    animationEnd(second, "x");
    expect(second.hasAttribute("data-x")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("outlasts its animation in the stylesheet: the timeouts are longer", () => {
    expect(TAB_STATUS_TRANSIENT_TIMEOUTS.pop).toBeGreaterThan(420);
    expect(TAB_STATUS_TRANSIENT_TIMEOUTS.title).toBeGreaterThan(240);
  });
});

describe("writeTabIconSize", () => {
  it("writes the one size the stylesheet reads, and nothing else", () => {
    const header = document.createElement("div");
    writeTabIconSize(header);
    expect(header.getAttributeNames()).toEqual([TAB_STATUS_ATTRIBUTES.size]);
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe("22");
    expect(TAB_ICON_SIZE).toBe(22);
  });

  it("leaves the header alone when the size is already there", () => {
    const header = document.createElement("div"),
      set = vi.spyOn(header, "setAttribute");
    writeTabIconSize(header);
    writeTabIconSize(header);
    expect(set).toHaveBeenCalledOnce();
  });
});

/** A tab's icon element holding an icon drawn under `id`, as Obsidian marks it. */
function drawn(id: string | null): {
  readonly icon: HTMLElement;
  readonly svg: Element | null;
} {
  const icon = document.createElement("div");
  if (id === null) {
    return { icon, svg: null };
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("svg-icon", id);
  icon.append(svg);
  return { icon, svg };
}

describe("writeTabIcon", () => {
  it("draws the icon where there is none", () => {
    const { icon } = drawn(null),
      draw = vi.fn<(element: HTMLElement, id: string) => void>();
    writeTabIcon(icon, "terminal:tab-bezel", draw);
    expect(draw).toHaveBeenCalledExactlyOnceWith(icon, "terminal:tab-bezel");
  });

  it.each([
    ["lucide-terminal", "terminal:tab-bezel"],
    ["lucide-terminal", "terminal:tab-tile"],
    ["terminal:tab-tile", "terminal:tab-bezel"],
    ["terminal:tab-bezel", "terminal:tab-tile"],
    ["terminal:tab-gone", "terminal:tab-tile"],
  ])(
    "draws %s over with %s, the icon of another Program status",
    (saved, id) => {
      const { icon } = drawn(saved),
        draw = vi.fn<(element: HTMLElement, id: string) => void>();
      writeTabIcon(icon, id, draw);
      expect(draw).toHaveBeenCalledExactlyOnceWith(icon, id);
    },
  );

  it.each(["terminal:tab-bezel", "terminal:tab-tile"])(
    "leaves an icon that is already %s",
    (id) => {
      const { icon, svg } = drawn(id),
        draw = vi.fn<(element: HTMLElement, id: string) => void>();
      writeTabIcon(icon, id, draw);
      expect(draw).not.toHaveBeenCalled();
      expect(icon.firstElementChild).toBe(svg);
    },
  );
});

describe("onWindowFocus", () => {
  /** An element as Obsidian extends it, and the call that moves it to a window. */
  function movable(): {
    readonly element: HTMLElement;
    readonly move: (win: Window) => void;
    readonly unfollow: ReturnType<typeof vi.fn<() => void>>;
  } {
    const element = document.createElement("div"),
      unfollow = vi.fn<() => void>(),
      followers: ((win: Window) => void)[] = [];
    Object.assign(element, {
      onWindowMigrated: vi.fn((follower: (win: Window) => void) => {
        followers.push(follower);
        return unfollow;
      }),
    });
    return {
      element,
      move(win): void {
        for (const follower of followers) follower(win);
      },
      unfollow,
    };
  }

  /** A second window: the frame's own, which has its own focus. */
  function otherWindow(): Window {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const { contentWindow } = frame;
    if (contentWindow === null) {
      throw new Error("the frame has no window");
    }
    return contentWindow;
  }

  it("calls the listener when the element's window gets the focus", () => {
    const { element } = movable(),
      listener = vi.fn<() => void>(),
      stop = onWindowFocus(element, window, listener);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("goes with the element to another window", () => {
    const { element, move } = movable(),
      popout = otherWindow(),
      listener = vi.fn<() => void>(),
      stop = onWindowFocus(element, window, listener);
    move(popout);
    // The window it left no longer says anything about this tab.
    window.dispatchEvent(new Event("focus"));
    expect(listener).not.toHaveBeenCalled();
    popout.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledOnce();
    // And back again.
    move(window);
    popout.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops listening on the window the element is in by then, and stops following", () => {
    const { element, move, unfollow } = movable(),
      popout = otherWindow(),
      listener = vi.fn<() => void>(),
      stop = onWindowFocus(element, window, listener);
    move(popout);
    stop();
    expect(unfollow).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    popout.dispatchEvent(new Event("focus"));
    expect(listener).not.toHaveBeenCalled();
  });
});
