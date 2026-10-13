/**
 * Unit tests for `src/terminal/tab-status.ts` — the status a terminal tab shows.
 *
 * Covers:
 * - what is displayed for each reported state, seen and unseen
 * - what counts as unread: a finished program until the user looks, whatever
 *   the settings
 * - the three attributes written on the header, and nothing besides them
 * - idempotent writes and cleanup
 * - the size and the icon written on a tab that has no presenter, and the
 *   plain icon put back on it
 * - the window focus listener that goes with a tab into another window
 */
import { describe, expect, it, vi } from "vitest";
import {
  TAB_STATUS_ATTRIBUTES,
  type TabStatusLook,
  TabStatusPresenter,
  needsAttention,
  onWindowFocus,
  restoreTabIcon,
  writeTabIcon,
  writeTabIconSize,
} from "../../../src/terminal/tab-status.js";

const LOOK: TabStatusLook = {
  animation: "none",
  set: "bezel",
  size: 18,
};

/** Attributes of earlier designs. Nothing writes them any more. */
const REMOVED_ATTRIBUTES = [
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

describe("TAB_STATUS_ATTRIBUTES", () => {
  it("names the three attributes the stylesheet reads", () => {
    expect(TAB_STATUS_ATTRIBUTES).toEqual({
      animation: "data-terminal-animation",
      size: "data-terminal-size",
      status: "data-terminal-status",
    });
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
    ).toEqual(["animation", "set", "size"]);
  });

  it.each([
    { ...LOOK, animation: "loop" },
    { ...LOOK, set: "tile" },
    { ...LOOK, size: 24 },
  ] satisfies readonly TabStatusLook[])(
    "shows an unseen finish as done under any look (%j), and as seen only once the user looks",
    (other) => {
      const { header, look, presenter } = fixture(other);
      presenter.report("done");
      expect(status(header)).toBe("done");
      expect(presenter.display).toBe("done");
      expect(presenter.unread).toBe(true);
      // No change of the look stands in for the user's look.
      look.mockReturnValue(LOOK);
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
    look.mockReturnValue({ ...LOOK, animation: "loop" });
    presenter.render();
    expect(status(header)).toBe("seen");
    expect(presenter.unread).toBe(false);
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("loop");
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

  it("writes the look from the settings", () => {
    const { header, presenter } = fixture({
      animation: "loop",
      set: "tile",
      size: 22,
    });
    presenter.render();
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe("22");
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("loop");
  });

  it("follows a changed look on the next render", () => {
    const { header, look, presenter } = fixture();
    presenter.render();
    look.mockReturnValue({
      ...LOOK,
      animation: "loop",
      size: 24,
    });
    presenter.render();
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("loop");
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe("24");
  });

  it.each(["idle", "working", "done", "blocked", "error"] as const)(
    "writes the status, the size and the animation for %s, and nothing else",
    (state) => {
      const { header, presenter } = fixture({
        ...LOOK,
        animation: "loop",
        set: "tile",
      });
      presenter.report(state);
      // Only these three, and no inline style: a timer that wrote a count
      // here four times a second was what made the motion jerk.
      expect(header.getAttributeNames().sort()).toEqual([
        "data-terminal-animation",
        "data-terminal-size",
        "data-terminal-status",
      ]);
      for (const name of REMOVED_ATTRIBUTES) {
        expect(header.hasAttribute(name)).toBe(false);
      }
      presenter.look();
      expect(header.getAttributeNames().sort()).toEqual([
        "data-terminal-animation",
        "data-terminal-size",
        "data-terminal-status",
      ]);
    },
  );

  it("writes nothing for the icon set: the tab's icon is of it", () => {
    const { header, look, presenter } = fixture();
    presenter.report("working");
    const before = header.outerHTML;
    look.mockReturnValue({ ...LOOK, set: "tile" });
    presenter.render();
    expect(header.outerHTML).toBe(before);
  });

  it("leaves the attributes of others on the header alone", () => {
    const { header, presenter } = fixture();
    header.setAttribute("data-type", "terminal:terminal");
    header.setAttribute("aria-label", "Terminal");
    presenter.report("error");
    presenter.clear();
    expect(header.getAttributeNames()).toEqual(["data-type", "aria-label"]);
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

  it("removes every attribute on clear and forgets the state", () => {
    const { header, presenter } = fixture();
    presenter.report("blocked");
    presenter.clear();
    expect(header.getAttributeNames()).toEqual([]);
    expect(presenter.display).toBeNull();
    expect(presenter.unread).toBe(false);
  });

  it("leaves continuous motion to the stylesheet: a working tab gets the animation and nothing that counts", () => {
    const { header, look, presenter } = fixture({ ...LOOK, animation: "loop" });
    presenter.report("working");
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("loop");
    expect(status(header)).toBe("working");
    expect(header.hasAttribute("style")).toBe(false);
    look.mockReturnValue(LOOK);
    presenter.render();
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.animation)).toBe("none");
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
    // A tab moved to another window comes back with a new header.
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
      look: () => LOOK,
      lookedAt: () => false,
    });
    expect(() => {
      presenter.report("done");
      presenter.look();
      presenter.render();
      presenter.clear();
    }).not.toThrow();
  });
});

describe("writeTabIconSize", () => {
  it("writes the size the stylesheet reads, and nothing else", () => {
    const header = document.createElement("div");
    writeTabIconSize(header, 22);
    expect(header.getAttributeNames()).toEqual([TAB_STATUS_ATTRIBUTES.size]);
    expect(header.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe("22");
  });

  it("writes what a presenter would write for the same size", () => {
    const { header, presenter } = fixture({ ...LOOK, size: 20 }),
      unloaded = document.createElement("div");
    presenter.render();
    writeTabIconSize(unloaded, 20);
    expect(unloaded.getAttribute(TAB_STATUS_ATTRIBUTES.size)).toBe(
      header.getAttribute(TAB_STATUS_ATTRIBUTES.size),
    );
  });

  it("takes the size back", () => {
    const header = document.createElement("div");
    header.setAttribute("data-type", "terminal:terminal");
    writeTabIconSize(header, 18);
    writeTabIconSize(header, null);
    expect(header.getAttributeNames()).toEqual(["data-type"]);
  });

  it("leaves the header alone when the size is already there", () => {
    const header = document.createElement("div"),
      set = vi.spyOn(header, "setAttribute");
    writeTabIconSize(header, 18);
    writeTabIconSize(header, 18);
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

  it("draws the chosen icon over the one saved with the layout", () => {
    const { icon } = drawn("lucide-terminal"),
      draw = vi.fn<(element: HTMLElement, id: string) => void>();
    writeTabIcon(icon, "terminal:tab-tile", draw);
    expect(draw).toHaveBeenCalledExactlyOnceWith(icon, "terminal:tab-tile");
  });

  it("leaves an icon that is already the chosen one", () => {
    const { icon, svg } = drawn("terminal:tab-tile"),
      draw = vi.fn<(element: HTMLElement, id: string) => void>();
    writeTabIcon(icon, "terminal:tab-tile", draw);
    expect(draw).not.toHaveBeenCalled();
    expect(icon.firstElementChild).toBe(svg);
  });
});

describe("restoreTabIcon", () => {
  it.each(["terminal:tab-bezel", "terminal:tab-tile"])(
    "puts the plain icon back where %s is drawn",
    (ours) => {
      const { icon } = drawn(ours),
        draw = vi.fn<(element: HTMLElement, id: string) => void>();
      restoreTabIcon(icon, "terminal:tab-", "terminal", draw);
      expect(draw).toHaveBeenCalledExactlyOnceWith(icon, "terminal");
    },
  );

  it("puts it back where the icon of a set that no longer exists is drawn", () => {
    const { icon } = drawn("terminal:tab-bezelround"),
      draw = vi.fn<(element: HTMLElement, id: string) => void>();
    restoreTabIcon(icon, "terminal:tab-", "terminal", draw);
    expect(draw).toHaveBeenCalledExactlyOnceWith(icon, "terminal");
  });

  it.each(["lucide-terminal", "terminal:linux", "lucide-file", null])(
    "leaves a tab alone that shows %s",
    (other) => {
      const { icon, svg } = drawn(other),
        draw = vi.fn<(element: HTMLElement, id: string) => void>();
      restoreTabIcon(icon, "terminal:tab-", "terminal", draw);
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
