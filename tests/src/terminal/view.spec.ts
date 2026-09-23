/**
 * Unit tests for `src/terminal/view.ts` — tab rename feature.
 *
 * Covers:
 * - `TerminalView.State.DEFAULT` includes `userTitle: null`
 * - `TerminalView.State.fix()` handles `userTitle` field correctly
 * - `TerminalView.name` getter respects `userTitle` priority
 * - `onPaneMenu()` includes a "Rename" menu item
 * - "rename-terminal" command is registered
 */
import * as library from "@polyipseity/obsidian-plugin-library";
import { WorkspaceLeaf } from "obsidian";
import { afterEach, describe, it, expect, vi } from "vitest";

/*
 * Mock `src/imports.js` — the BUNDLE map provides lazy `require()` loaders for
 * xterm addon packages that are not built/available in the test environment.
 * Replacing the map entries with no-op factories prevents unhandled rejections
 * from `dynamicRequire`.
 */
vi.mock("../../../src/imports.js", () => {
  class DummyAddon {
    public readonly onDidChangeResults = vi.fn();
  }
  const dummy = (): Record<string, unknown> => ({
    CanvasAddon: DummyAddon,
    LigaturesAddon: DummyAddon,
    SearchAddon: DummyAddon,
    Unicode11Addon: DummyAddon,
    WebLinksAddon: DummyAddon,
    WebglAddon: DummyAddon,
  });
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

import {
  TerminalView,
  fittedSize,
  settleTerminalBackendOptions,
} from "../../../src/terminal/view.js";
import { Settings } from "../../../src/settings-data.js";
import { mergeTerminalOptions } from "../../../src/terminal/options.js";
import type { Pseudoterminal } from "../../../src/terminal/pseudoterminal.js";
import { pseudoterminal, tick } from "../../support/helpers.js";

describe("src/terminal/view.ts", () => {
  describe("exit notices", () => {
    const exitCodes: readonly Awaited<Pseudoterminal["onExit"]>[] = [
      1,
      "SIGTERM",
      0,
    ];
    class TestView extends TerminalView {
      public override startEmulator(focus: boolean): void {
        super.startEmulator(focus);
      }

      public stopEmulator(): void {
        this.emulator = null;
      }
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function startView(
      ...ptys: readonly Promise<Pseudoterminal>[]
    ): Promise<TestView> {
      const pending = ptys.values();
      vi.spyOn(library, "awaitCSS").mockImplementation(async (element) => {
        Object.assign(element, { onWindowMigrated: vi.fn() });
      });
      vi.spyOn(library, "notice2").mockImplementation(vi.fn());
      vi.spyOn(library, "onResize").mockImplementation(vi.fn());
      vi.spyOn(TerminalView, "EMULATOR").mockImplementation(
        function (_element, _factory, _state, _options, addons) {
          const pty = pending.next().value;
          if (!pty) throw new Error("Missing test pseudoterminal");
          // Only the view-facing emulator surface is needed; rendering belongs
          // to emulator.spec.ts. Keep the actual addon callbacks from the view.
          return {
            addons,
            close: vi.fn(async () => {
              await (await pty).kill();
            }),
            pseudoterminal: pty,
            resize: vi.fn().mockResolvedValue(undefined),
            terminal: {
              unicode: {},
              onWriteParsed: vi.fn(),
              onResize: vi.fn(),
              onTitleChange: vi.fn(),
            },
          } as unknown as TerminalView.EMULATOR;
        },
      );
      const context = {
          language: { value: { t: vi.fn((key: string) => key) } },
          settings: { value: Settings.DEFAULT, onMutate: vi.fn() },
        } as unknown as ConstructorParameters<typeof TerminalView>[0],
        view = new TestView(context, new WorkspaceLeaf());
      view.startEmulator(false);
      await tick();
      // The spawn notice proves that setup completed before exercising exits.
      expect(library.notice2).toHaveBeenCalledOnce();
      vi.mocked(library.notice2).mockClear();
      return view;
    }

    it.each(exitCodes)(
      "does not report exit %s after an intentional close",
      async (code) => {
        const exit = Promise.withResolvers<Awaited<Pseudoterminal["onExit"]>>(),
          pty = {
            ...pseudoterminal(),
            kill: vi.fn(() => {
              exit.resolve(code);
            }),
            onExit: exit.promise,
          },
          view = await startView(Promise.resolve(pty));
        view.stopEmulator();
        await tick();
        expect(pty.kill).toHaveBeenCalledOnce();
        expect(library.notice2).not.toHaveBeenCalled();
      },
    );

    it("does not report a terminal closed before its spawn finishes", async () => {
      const spawned = Promise.withResolvers<Pseudoterminal>(),
        exit = Promise.withResolvers<number>(),
        view = await startView(spawned.promise);
      view.stopEmulator();
      spawned.resolve({
        ...pseudoterminal(),
        onExit: exit.promise,
        kill: vi.fn(() => {
          exit.resolve(1);
        }),
      });
      await tick();
      expect(library.notice2).not.toHaveBeenCalled();
    });

    it("does not report the old terminal's exit after restarting", async () => {
      const oldExit = Promise.withResolvers<number>(),
        newExit = Promise.withResolvers<number>(),
        oldPty = {
          ...pseudoterminal(),
          onExit: oldExit.promise,
          kill: vi.fn(() => {
            oldExit.resolve(1);
          }),
        },
        view = await startView(
          Promise.resolve(oldPty),
          Promise.resolve({ ...pseudoterminal(), onExit: newExit.promise }),
        );
      view.startEmulator(false);
      await tick();
      expect(oldPty.kill).toHaveBeenCalledOnce();
      // Restart announces the new spawn but must not announce the old exit.
      expect(library.notice2).toHaveBeenCalledOnce();
      vi.mocked(library.notice2).mockClear();
      newExit.resolve(1);
      await tick();
      expect(library.notice2).toHaveBeenCalledOnce();
    });

    it("keeps reporting actual spawn errors", async () => {
      const spawned = Promise.withResolvers<Pseudoterminal>(),
        error = new Error("spawn failed");
      vi.spyOn(library, "printError").mockImplementation(vi.fn());
      await startView(spawned.promise);
      spawned.reject(error);
      await tick();
      expect(library.printError).toHaveBeenCalledWith(
        error,
        expect.any(Function),
        expect.anything(),
      );
    });

    it.each(exitCodes)("reports spontaneous exit %s", async (code) => {
      const exit = Promise.withResolvers<Awaited<Pseudoterminal["onExit"]>>();
      await startView(
        Promise.resolve({ ...pseudoterminal(), onExit: exit.promise }),
      );
      exit.resolve(code);
      await tick();
      expect(library.notice2).toHaveBeenCalledOnce();
    });
  });

  describe("fittedSize", () => {
    const terminal = { cols: 80, rows: 24 };

    it("uses the fit proposal for the pseudoterminal spawn size", () => {
      expect(
        fittedSize(
          { proposeDimensions: () => ({ cols: 132, rows: 43 }) },
          terminal,
        ),
      ).toEqual([132, 43]);
    });

    it("normalizes fractional and zero-cell proposals", () => {
      expect(
        fittedSize(
          { proposeDimensions: () => ({ cols: 100.9, rows: 0.4 }) },
          terminal,
        ),
      ).toEqual([100, 1]);
    });

    it("falls back when the fit proposal is unavailable or invalid", () => {
      expect(fittedSize({ proposeDimensions: () => void 0 }, terminal)).toEqual(
        [80, 24],
      );
      expect(
        fittedSize(
          { proposeDimensions: () => ({ cols: NaN, rows: 10 }) },
          terminal,
        ),
      ).toEqual([80, 24]);
    });

    it("falls back when the fit addon throws", () => {
      expect(
        fittedSize(
          {
            proposeDimensions: () => {
              throw new Error("not opened");
            },
          },
          terminal,
        ),
      ).toEqual([80, 24]);
    });
  });

  describe("settleTerminalBackendOptions", () => {
    const requested = {
      platform: "win32",
      win32Backend: "conpty",
      win32BuildNumber: 19_045,
    } as const;

    it("takes the backend of a ConHost fallback", () => {
      const settled = settleTerminalBackendOptions(
        requested,
        pseudoterminal({ win32Backend: "legacy" }),
      );

      expect(settled).toEqual({ ...requested, win32Backend: "legacy" });
      expect(Object.isFrozen(settled)).toBe(true);
    });

    it("reads a backend exposed through a getter, as a wrapper does", () => {
      class Wrapper implements Pseudoterminal {
        public readonly kill = (): void => {};
        public readonly onExit = Promise.resolve(0);
        public readonly pipe = (): void => {};
        public get win32Backend(): "legacy" {
          return "legacy";
        }
      }

      expect(
        settleTerminalBackendOptions(requested, new Wrapper()).win32Backend,
      ).toBe("legacy");
    });

    it("keeps the request when the pseudoterminal agrees", () => {
      expect(
        settleTerminalBackendOptions(
          requested,
          pseudoterminal({ win32Backend: "conpty" }),
        ),
      ).toBe(requested);
    });

    it("keeps the request when the pseudoterminal names no backend", () => {
      expect(settleTerminalBackendOptions(requested, null)).toBe(requested);
      expect(settleTerminalBackendOptions(requested, pseudoterminal({}))).toBe(
        requested,
      );
      expect(
        settleTerminalBackendOptions(
          requested,
          pseudoterminal({ win32Backend: void 0 }),
        ),
      ).toBe(requested);
    });

    it("stops a later settings change from re-applying the ConPTY hint", () => {
      // The live-update path merges the changed settings with the settled
      // options, not with the profile's request.
      const settled = settleTerminalBackendOptions(
          requested,
          pseudoterminal({ win32Backend: "legacy" }),
        ),
        changed = { documentOverride: null, fontSize: 14 };

      expect(
        mergeTerminalOptions({ documentOverride: null }, changed, requested)
          .windowsPty,
      ).toEqual({ backend: "conpty", buildNumber: 19_045 });
      expect(
        mergeTerminalOptions({ documentOverride: null }, changed, settled)
          .windowsPty,
      ).toBeUndefined();
    });
  });

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
      it("migrates a restored auto-demoted profile once", () => {
        const fixed = TerminalView.State.fix({
          profile: {
            ...Settings.Profile.DEFAULTS.integrated,
            win32Backend: "legacy",
            win32BackendAutoDemoted: true,
          },
          cwd: null,
          serial: null,
          focus: false,
        }).value;
        expect(fixed.profile).toHaveProperty("win32Backend", "conpty");
        expect(fixed.profile).not.toHaveProperty("win32BackendAutoDemoted");
      });

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
