/**
 * Unit tests for `src/terminal/view.ts` — tab names, opening, and placement.
 *
 * Covers:
 * - `TerminalView.State` defaults and `fix()`
 * - `getDisplayText`
 * - `spawn` reveal and focus rules
 * - `getLeaf` session-usage anchoring
 * - Copy and edit pane-menu entries
 */
import { readStateCollaboratively } from "@polyipseity/obsidian-plugin-library";
import { App, type Menu, type MenuItem, View, WorkspaceLeaf } from "obsidian";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { TerminalPlugin } from "../../../src/main.js";
import { Settings } from "../../../src/settings-data.js";
import { EditTerminalModal, TerminalView } from "../../../src/terminal/view.js";

vi.mock("obsidian", async () => {
  // The shared mock has no base View; ItemView supplies its leaf contract here.
  const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
  return { ...actual, View: actual.ItemView };
});

/*
 * Mock `src/imports.js` — the BUNDLE map provides lazy `require()` loaders for
 * xterm addon packages that are not built/available in the test environment.
 * Replacing the map entries with no-op factories prevents unhandled rejections
 * from `dynamicRequire`.
 */
vi.mock("../../../src/imports.js", () => {
  const dummy = (): Record<string, unknown> => ({});
  const entries: Array<[string, () => Record<string, unknown>]> = [
    ["@xterm/addon-canvas", dummy],
    ["@xterm/addon-fit", dummy],
    ["@xterm/addon-ligatures", dummy],
    ["@xterm/addon-search", dummy],
    ["@xterm/addon-serialize", dummy],
    ["@xterm/addon-unicode11", dummy],
    ["@xterm/addon-web-links", dummy],
    ["@xterm/addon-webgl", dummy],
    ["@xterm/xterm", dummy],
    ["tmp-promise", dummy],
  ];
  return {
    BUNDLE: new Map(entries),
    MODULES: entries.map(([key]) => key),
  };
});

// Fixtures supply only the host API used here; this boundary cast bridges the
// intentionally partial plugin stub to the full plugin type.
function makeTerminalContext(overrides: Partial<Settings> = {}) {
  const app = new App();
  const settings = { ...Settings.DEFAULT, ...overrides };
  const context = {
    id: "terminal",
    app,
    settings: { value: settings, onMutate: vi.fn(() => vi.fn()) },
    language: {
      value: { t: vi.fn((key: string) => key) },
      onChangeLanguage: { listen: vi.fn(() => vi.fn()) },
    },
    statusBarHider: { hide: vi.fn(() => vi.fn()), update: vi.fn() },
  } as unknown as TerminalPlugin;
  const { workspace } = app;
  const next = makeTerminalLeaf(context).leaf;
  return {
    context,
    settings,
    workspace,
    next,
    allocate: vi.spyOn(workspace, "getLeaf").mockReturnValue(next),
    reveal: vi.spyOn(workspace, "revealLeaf"),
    activate: vi.spyOn(workspace, "setActiveLeaf"),
  };
}

const terminalViews: TerminalView[] = [];

function makeTerminalLeaf(context: TerminalPlugin) {
  const leaf = new WorkspaceLeaf();
  const view = new TerminalView(context, leaf);
  view.app = context.app;
  view.load();
  terminalViews.push(view);
  // Call matchers compare arguments structurally; the id keeps two mock leaves
  // in the same state from matching each other.
  Object.assign(leaf, { view, id: terminalViews.length });
  vi.spyOn(view, "getViewType").mockReturnValue(
    TerminalView.type.namespaced(context),
  );
  return { leaf, view, setViewState: vi.spyOn(leaf, "setViewState") };
}

function deferred() {
  // The promise executor assigns the resolver synchronously.
  let resolve!: (value: undefined) => void;
  const promise = new Promise<undefined>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const view of terminalViews.splice(0)) view.unload();
  vi.restoreAllMocks();
});

describe("src/terminal/view.ts", () => {
  describe("TerminalView.State", () => {
    describe("State.DEFAULT", () => {
      it("includes userTitle set to empty string", () => {
        expect(TerminalView.State.DEFAULT).toHaveProperty("userTitle");
        expect(TerminalView.State.DEFAULT.userTitle).toBe("");
      });

      it("preserves existing default fields", () => {
        expect(TerminalView.State.DEFAULT).toHaveProperty("cwd", null);
        expect(TerminalView.State.DEFAULT).toHaveProperty("focus", false);
        expect(TerminalView.State.DEFAULT).toHaveProperty("profile");
        expect(TerminalView.State.DEFAULT).toHaveProperty("serial", null);
      });
    });

    describe("State.fix()", () => {
      it("preserves a valid userTitle string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: "My Custom Terminal",
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("My Custom Terminal");
      });

      it("coerces missing userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
      });

      it("coerces non-string userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: 42,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
      });

      it("coerces boolean userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: true,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
      });

      it("coerces null userTitle to empty string", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: null,
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.userTitle).toBe("");
      });

      it("preserves empty string userTitle", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.integrated,
          cwd: null,
          serial: null,
          focus: false,
          userTitle: "",
        };
        const fixed = TerminalView.State.fix(input);
        // Empty string is a valid string — should be preserved
        expect(fixed.value.userTitle).toBe("");
      });

      it("does not affect other state fields when userTitle is present", () => {
        const input = {
          profile: Settings.Profile.DEFAULTS.external,
          cwd: "/home/user",
          serial: null,
          focus: true,
          userTitle: "dev server",
        };
        const fixed = TerminalView.State.fix(input);
        expect(fixed.value.cwd).toBe("/home/user");
        expect(fixed.value.userTitle).toBe("dev server");
      });
    });
  });

  describe("getDisplayText", () => {
    it("returns title directly when showTerminalTabPrefix is disabled", async () => {
      const { WorkspaceLeaf } = await import("obsidian");
      const mockI18n = { t: vi.fn((key: string) => key) };
      const mockContext = {
        language: { value: mockI18n },
        settings: { value: { showTerminalTabPrefix: false } },
      } as unknown as ConstructorParameters<typeof TerminalView>[0];
      const leaf = new WorkspaceLeaf();
      const view = new TerminalView(mockContext, leaf);

      const result = view.getDisplayText();
      expect(mockI18n.t).toHaveBeenCalledWith(
        "components.terminal.name.profile-type",
        expect.any(Object),
      );
      expect(result).toBe("components.terminal.name.profile-type");
    });

    it("returns localized display-name when showTerminalTabPrefix is enabled", async () => {
      const { WorkspaceLeaf } = await import("obsidian");
      const mockI18n = { t: vi.fn((key: string) => key) };
      const mockContext = {
        language: { value: mockI18n },
        settings: { value: { showTerminalTabPrefix: true } },
      } as unknown as ConstructorParameters<typeof TerminalView>[0];
      const leaf = new WorkspaceLeaf();
      const view = new TerminalView(mockContext, leaf);

      const result = view.getDisplayText();
      expect(mockI18n.t).toHaveBeenCalledWith(
        "components.terminal.display-name",
        expect.objectContaining({ title: expect.any(String) as unknown }),
      );
      expect(result).toBe("components.terminal.display-name");
    });
  });
});

describe("TerminalView.spawn", () => {
  describe.each([true, false])("with focus=%s", (focus) => {
    it.each(Settings.NEW_INSTANCE_BEHAVIORS)(
      "reveals the allocated terminal for %s regardless of focus intent",
      async (newInstanceBehavior) => {
        const { context, workspace, reveal, activate, allocate } =
          makeTerminalContext({
            createInstanceNearExistingOnes: false,
            newInstanceBehavior,
          });
        const main = makeTerminalLeaf(context);
        const left = makeTerminalLeaf(context);
        const right = makeTerminalLeaf(context);
        const target = newInstanceBehavior.startsWith("newLeft")
          ? left
          : newInstanceBehavior.startsWith("newRight")
            ? right
            : main;
        allocate.mockReturnValue(main.leaf);
        vi.spyOn(workspace, "getLeftLeaf").mockReturnValue(left.leaf);
        vi.spyOn(workspace, "getRightLeaf").mockReturnValue(right.leaf);
        vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([target.leaf]);

        await TerminalView.spawn(context, {
          ...TerminalView.State.DEFAULT,
          focus,
        });

        expect(target.setViewState).toHaveBeenCalledOnce();
        expect(reveal).toHaveBeenCalledExactlyOnceWith(target.leaf);
        expect(activate.mock.calls).toEqual(
          focus ? [[target.leaf, { focus: true }]] : [],
        );
      },
    );

    it("uses state.focus when the setting disagrees", async () => {
      const { context, workspace, reveal, activate } = makeTerminalContext({
        focusOnNewInstance: !focus,
      });
      const { leaf } = makeTerminalLeaf(context);
      vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

      await TerminalView.spawn(
        context,
        { ...TerminalView.State.DEFAULT, focus },
        leaf,
      );

      expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
      expect(activate.mock.calls).toEqual(
        focus ? [[leaf, { focus: true }]] : [],
      );
    });
  });

  it("waits for setViewState before revealing and for reveal before activating", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    const stateReady = deferred();
    const revealed = deferred();
    const state = { ...TerminalView.State.DEFAULT, focus: true };
    setViewState.mockReturnValue(stateReady.promise);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    reveal.mockReturnValue(revealed.promise);

    const opening = TerminalView.spawn(context, state, leaf);
    // setState can consume the caller's focus intent before its promise settles.
    state.focus = false;
    expect(setViewState).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();

    stateReady.resolve(undefined);
    await stateReady.promise;
    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();

    revealed.resolve(undefined);
    await opening;
    expect(activate).toHaveBeenCalledExactlyOnceWith(leaf, { focus: true });
  });

  it("reveals without requesting keyboard focus when state.focus is false", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();
    expect(setViewState.mock.calls[0]?.[0]).not.toHaveProperty("active");
  });

  it("activates the revealed terminal without focus when it replaced the active tab", async () => {
    const { context, workspace, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    const active = makeTerminalLeaf(context);
    const parent = {};
    Object.assign(leaf, { parent });
    Object.assign(active.leaf, { parent });
    Object.assign(active.view, {
      containerEl: { offsetParent: null },
    });
    const getActiveViewOfType = vi
      .spyOn(workspace, "getActiveViewOfType")
      .mockReturnValue(active.view);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(activate.mock.calls).toEqual([[leaf]]);
    expect(getActiveViewOfType).toHaveBeenCalledExactlyOnceWith(View);
  });

  it("leaves the active leaf alone when its tab is still shown", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    const active = makeTerminalLeaf(context);
    const parent = {};
    Object.assign(leaf, { parent });
    Object.assign(active.leaf, { parent });
    Object.assign(active.view, {
      containerEl: { offsetParent: document.body },
    });
    vi.spyOn(workspace, "getActiveViewOfType").mockReturnValue(active.view);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();
  });

  it("leaves the active leaf alone when it is in another tab group", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    const active = makeTerminalLeaf(context);
    Object.assign(leaf, { parent: {} });
    Object.assign(active.leaf, { parent: {} });
    Object.assign(active.view, {
      containerEl: { offsetParent: null },
    });
    vi.spyOn(workspace, "getActiveViewOfType").mockReturnValue(active.view);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).not.toHaveBeenCalled();
  });

  it("leaves the active leaf alone when no view is active", async () => {
    const { context, workspace, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getActiveViewOfType").mockReturnValue(null);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      leaf,
    );

    expect(activate).not.toHaveBeenCalled();
  });

  it("reveals an explicit destination without allocating another leaf", async () => {
    const { context, workspace, allocate, reveal } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    const left = vi.spyOn(workspace, "getLeftLeaf");
    const right = vi.spyOn(workspace, "getRightLeaf");

    await TerminalView.spawn(context, TerminalView.State.DEFAULT, leaf);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(allocate).not.toHaveBeenCalled();
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
  });

  it("preserves collaborative state and the requested type without active", async () => {
    const { context, workspace, reveal } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    const type = "terminal:custom-view";
    const state = {
      ...TerminalView.State.DEFAULT,
      cwd: "/workspace",
      profile: Settings.Profile.DEFAULTS.integrated,
      profileSourceId: "shell",
      userTitle: "Build",
      focus: true,
    };
    vi.spyOn(workspace, "getLeavesOfType").mockImplementation(
      (requestedType) => (requestedType === type ? [leaf] : []),
    );

    await TerminalView.spawn(context, state, leaf, type);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    const request = setViewState.mock.calls[0]?.[0];
    expect(request).toEqual({
      state: { [TerminalView.type.namespaced(context)]: state },
      type,
    });
    expect(
      readStateCollaboratively(
        TerminalView.type.namespaced(context),
        request?.state,
      ),
    ).toBe(state);
    expect(request).not.toHaveProperty("active");
  });

  it("propagates reveal failure without activating or recording the open", async () => {
    const { context, workspace, next, reveal, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const used = makeTerminalLeaf(context);
    const failed = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      used.leaf,
      failed.leaf,
    ]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, used.leaf);
    const failure = new Error("reveal failed");
    reveal.mockRejectedValueOnce(failure);

    await expect(
      TerminalView.spawn(
        context,
        { ...TerminalView.State.DEFAULT, focus: true },
        failed.leaf,
      ),
    ).rejects.toBe(failure);

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(used.leaf);
  });

  it("propagates setViewState failure without revealing, activating, or recording the open", async () => {
    const { context, workspace, next, allocate, reveal, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const { leaf, setViewState } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    const failure = new Error("setViewState failed");
    setViewState.mockRejectedValueOnce(failure);

    await expect(
      TerminalView.spawn(
        context,
        { ...TerminalView.State.DEFAULT, focus: true },
        leaf,
      ),
    ).rejects.toBe(failure);

    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
  });

  it("skips reveal when setViewState detached the terminal", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    const leaves = vi
      .spyOn(workspace, "getLeavesOfType")
      .mockReturnValue([leaf]);
    setViewState.mockImplementation(() => {
      leaves.mockReturnValue([]);
      return Promise.resolve();
    });

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: true },
      leaf,
    );

    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("skips reveal when setViewState leaves a non-terminal view", async () => {
    const { context, workspace, reveal, activate } = makeTerminalContext();
    const { leaf, setViewState } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    setViewState.mockImplementation(() => {
      Object.assign(leaf, { view: {} });
      return Promise.resolve();
    });

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: true },
      leaf,
    );

    expect(reveal).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("supports a void-returning revealLeaf", async () => {
    const { context, workspace, activate } = makeTerminalContext();
    const { leaf } = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([leaf]);
    // Obsidian before 1.7.2 returned void from revealLeaf.
    const reveal = vi.fn<() => void>();
    Object.assign(workspace, { revealLeaf: reveal });

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: true },
      leaf,
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(activate).toHaveBeenCalledExactlyOnceWith(leaf, { focus: true });
  });
});

describe("TerminalView.getLeaf session usage", () => {
  it("chooses the last successfully opened terminal instead of traversal order", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
      });
    const first = makeTerminalLeaf(context);
    const second = makeTerminalLeaf(context);
    const hidden = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      first.leaf,
      second.leaf,
      hidden.leaf,
    ]);

    for (const target of [second, first, second]) {
      await TerminalView.spawn(
        context,
        TerminalView.State.DEFAULT,
        target.leaf,
      );
      activate.mockClear();
      allocate.mockClear();

      expect(TerminalView.getLeaf(context)).toBe(next);
      expect(activate).toHaveBeenCalledExactlyOnceWith(target.leaf);
      expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");
    }
  });

  it("chooses the last focused terminal", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const first = makeTerminalLeaf(context);
    const second = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      first.leaf,
      second.leaf,
    ]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, first.leaf);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, second.leaf);
    const events = vi.spyOn(first.view, "registerDomEvent");
    await first.view["onOpen"]();
    const focusin = events.mock.calls.find(([, type]) => type === "focusin");
    expect(focusin).toBeDefined();
    focusin?.[2].call(first.view.contentEl, new FocusEvent("focusin"));

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(first.leaf);
  });

  it("uses the next most recently used terminal after the latest closes", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const oldest = makeTerminalLeaf(context);
    const previous = makeTerminalLeaf(context);
    const latest = makeTerminalLeaf(context);
    const unused = makeTerminalLeaf(context);
    const leaves = vi
      .spyOn(workspace, "getLeavesOfType")
      .mockReturnValue([oldest.leaf, previous.leaf, latest.leaf, unused.leaf]);
    for (const target of [oldest, previous, latest]) {
      await TerminalView.spawn(
        context,
        TerminalView.State.DEFAULT,
        target.leaf,
      );
    }
    leaves.mockReturnValue([oldest.leaf, previous.leaf, unused.leaf]);

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(previous.leaf);
  });

  it("uses newInstanceBehavior when terminals exist but none was used this session", () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const unused = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([unused.leaf]);

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not make a terminal an anchor during onOpen", async () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const restored = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([restored.leaf]);

    await restored.view["onOpen"]();

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(activate).not.toHaveBeenCalled();
  });

  it("makes it an anchor once its focusin listener runs", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
      newInstanceBehavior: "newWindow",
    });
    const restored = makeTerminalLeaf(context);
    const unused = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      restored.leaf,
      unused.leaf,
    ]);
    const events = vi.spyOn(restored.view, "registerDomEvent");
    await restored.view["onOpen"]();
    const focusin = events.mock.calls.find(([, type]) => type === "focusin");
    expect(focusin).toBeDefined();
    focusin?.[2].call(restored.view.contentEl, new FocusEvent("focusin"));

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(restored.leaf);
  });

  it("does not inherit usage when a leaf receives a different terminal view", async () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: true,
        newInstanceBehavior: "newWindow",
      });
    const target = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([target.leaf]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, target.leaf);
    Object.assign(target.leaf, {
      view: new TerminalView(context, target.leaf),
    });

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(activate).not.toHaveBeenCalled();
  });

  it("remembers a revealed open when keyboard focus is disabled", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
      focusOnNewInstance: false,
    });
    const opened = makeTerminalLeaf(context);
    const hidden = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([
      opened.leaf,
      hidden.leaf,
    ]);

    await TerminalView.spawn(
      context,
      { ...TerminalView.State.DEFAULT, focus: false },
      opened.leaf,
    );

    expect(TerminalView.getLeaf(context)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(opened.leaf);
  });

  it("preserves an explicit anchor ahead of session candidates", async () => {
    const { context, workspace, next, activate } = makeTerminalContext({
      createInstanceNearExistingOnes: true,
    });
    const used = makeTerminalLeaf(context);
    const explicit = makeTerminalLeaf(context);
    vi.spyOn(workspace, "getLeavesOfType").mockReturnValue([used.leaf]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, used.leaf);

    expect(TerminalView.getLeaf(context, explicit.leaf)).toBe(next);
    expect(activate).toHaveBeenCalledExactlyOnceWith(explicit.leaf);
  });

  it("ignores session candidates when near-existing placement is disabled", async () => {
    const { context, workspace, next, allocate, activate } =
      makeTerminalContext({
        createInstanceNearExistingOnes: false,
        newInstanceBehavior: "newWindow",
      });
    const used = makeTerminalLeaf(context);
    const leaves = vi
      .spyOn(workspace, "getLeavesOfType")
      .mockReturnValue([used.leaf]);
    await TerminalView.spawn(context, TerminalView.State.DEFAULT, used.leaf);
    leaves.mockClear();

    expect(TerminalView.getLeaf(context, used.leaf)).toBe(next);
    expect(allocate).toHaveBeenCalledExactlyOnceWith("window");
    expect(leaves).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  describe.each([true, false])("with pinNewInstance=%s", (pinNewInstance) => {
    describe.each(["Left", "Right"] as const)("in the %s sidebar", (side) => {
      it("preserves pinNewInstance and sidebar null fallbacks", () => {
        const { context, settings, workspace, next, allocate, activate } =
          makeTerminalContext({
            createInstanceNearExistingOnes: true,
            pinNewInstance,
          });
        const anchor = makeTerminalLeaf(context);
        vi.spyOn(anchor.leaf, "getRoot").mockReturnValue(
          side === "Left" ? workspace.leftSplit : workspace.rightSplit,
        );
        const sidebar = vi
          .spyOn(workspace, `get${side}Leaf`)
          .mockReturnValue(next);
        const pin = vi.spyOn(next, "setPinned");

        expect(TerminalView.getLeaf(context, anchor.leaf)).toBe(next);
        expect(sidebar).toHaveBeenCalledExactlyOnceWith(false);
        expect(activate).not.toHaveBeenCalled();
        expect(allocate).not.toHaveBeenCalled();

        sidebar.mockReturnValue(null);
        expect(TerminalView.getLeaf(context, anchor.leaf)).toBe(next);
        expect(activate).toHaveBeenCalledExactlyOnceWith(anchor.leaf);
        expect(allocate).toHaveBeenCalledExactlyOnceWith("tab");

        settings.createInstanceNearExistingOnes = false;
        for (const split of [false, true]) {
          settings.newInstanceBehavior = `new${side}${split ? "Split" : "Tab"}`;
          allocate.mockClear();
          sidebar.mockClear();
          expect(TerminalView.getLeaf(context)).toBe(next);
          expect(sidebar).toHaveBeenCalledExactlyOnceWith(split);
          expect(allocate.mock.calls).toEqual(
            split ? [["split", "horizontal"]] : [["tab"]],
          );
        }
        expect(pin.mock.calls).toEqual(Array(4).fill([pinNewInstance]));
      });
    });
  });
});

// The pane fixture records click callbacks without building Obsidian's menu UI.
function terminalPaneActions(view: TerminalView) {
  const actions = new Map<string, () => unknown>();
  const menu = {
    addSeparator: vi.fn(() => menu),
    addItem: vi.fn((setup: (item: MenuItem) => unknown) => {
      let title = "";
      const item = {
        setTitle: vi.fn((value: string) => {
          title = value;
          return item;
        }),
        setIcon: vi.fn(() => item),
        setDisabled: vi.fn(() => item),
        onClick: vi.fn((callback: () => unknown) => {
          actions.set(title, callback);
          return item;
        }),
      };
      setup(item as unknown as MenuItem);
      return menu;
    }),
  };
  view.onPaneMenu(menu as unknown as Menu, "tab-header");
  return actions;
}

describe("TerminalView pane menu", () => {
  describe.each([false, true])("with source focus=%s", (sourceFocus) => {
    it("copy passes the current focus setting without mutating the source state", async () => {
      const { context, settings } = makeTerminalContext({
        focusOnNewInstance: sourceFocus,
      });
      const source = makeTerminalLeaf(context);
      const target = makeTerminalLeaf(context);
      const sourceState = Object.freeze({
        ...TerminalView.State.DEFAULT,
        focus: sourceFocus,
        cwd: "/workspace",
        userTitle: "Source",
      });
      Object.defineProperty(source.view, "state", { value: sourceState });
      const allocate = vi
        .spyOn(TerminalView, "getLeaf")
        .mockReturnValue(target.leaf);
      const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue();
      const actions = terminalPaneActions(source.view);
      settings.focusOnNewInstance = !sourceFocus;

      await actions.get("components.terminal.menus.copy")?.();

      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        context,
        { ...sourceState, focus: !sourceFocus },
        target.leaf,
        source.view.getViewType(),
      );
      expect(allocate).toHaveBeenCalledExactlyOnceWith(context, source.leaf);
    });
  });

  it("edit keeps its existing focus intent", async () => {
    const { context } = makeTerminalContext({ focusOnNewInstance: true });
    const { leaf, view } = makeTerminalLeaf(context);
    const sourceState = Object.freeze({
      ...TerminalView.State.DEFAULT,
      focus: false,
      userTitle: "Source",
    });
    Object.defineProperty(view, "state", { value: sourceState });
    const spawn = vi.spyOn(TerminalView, "spawn").mockResolvedValue();
    const confirmations: Promise<void>[] = [];
    vi.spyOn(EditTerminalModal.prototype, "open").mockImplementation(function (
      this: EditTerminalModal,
    ) {
      confirmations.push(this["confirm"](vi.fn()));
    });

    terminalPaneActions(view).get("components.terminal.menus.edit")?.();
    await Promise.all(confirmations);

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      context,
      sourceState,
      leaf,
      view.getViewType(),
    );
  });
});
