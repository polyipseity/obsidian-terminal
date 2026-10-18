import { describe, it, expect, vi } from "vitest";
import {
  CONPTY_REFLOW_BUILD_NUMBER,
  type TerminalBackendOptions,
  consoleHostMayRaiseBuild,
  mergeTerminalOptions,
  applyTerminalOptionDiffShallow,
  parseWin32BuildNumber,
  settleConsoleHostBackendOptions,
} from "../../../src/terminal/options.js";
import { DEFAULT_LINK_HANDLER } from "../../../src/terminal/profile-presets.js";
import { Settings } from "../../../src/settings-data.js";
import type { ILinkHandler, Terminal } from "@xterm/xterm";

describe("mergeTerminalOptions", () => {
  const baseDefaults: Settings.Profile.TerminalOptions = {
    documentOverride: null,
    fontFamily: "foo",
    fontSize: 12,
  };

  it("uses global values when profile has none", () => {
    const result = mergeTerminalOptions(
      { documentOverride: null },
      baseDefaults,
    );
    expect(result.fontFamily).toBe("foo");
    expect(result.fontSize).toBe(12);
    // the helper always ensures these baseline fields
    expect(result.allowProposedApi).toBe(true);
    expect(result.macOptionIsMeta).toBe(false);
    // without a handler, xterm opens OSC 8 links via `window.open()`, which Obsidian blocks
    expect(result.linkHandler).toBe(DEFAULT_LINK_HANDLER);
  });

  it("allows profile values to override globals", () => {
    const prof = { documentOverride: null, fontFamily: "bar" };
    const result = mergeTerminalOptions(prof, baseDefaults);
    expect(result.fontFamily).toBe("bar");
    // unspecified keys should still come from globals
    expect(result.fontSize).toBe(12);
  });

  it("forces the ConPTY renderer hint for the ctypes backend on Windows", () => {
    const result = mergeTerminalOptions(
      {
        documentOverride: null,
        windowsPty: { backend: "winpty", buildNumber: 19_045 },
      },
      {
        ...baseDefaults,
        windowsPty: { backend: "conpty", buildNumber: 22_631 },
      },
      { platform: "win32", win32Backend: "conpty", win32BuildNumber: 26_100 },
    );

    // The persisted build survives, and wins over the machine's.
    expect(result.windowsPty).toEqual({
      backend: "conpty",
      buildNumber: 19_045,
    });
  });

  it("fills a missing build number from the machine's Windows build", () => {
    const backendOptions = {
      platform: "win32",
      win32Backend: "conpty",
      win32BuildNumber: 19_045,
    } as const;

    expect(
      mergeTerminalOptions(
        { documentOverride: null },
        baseDefaults,
        backendOptions,
      ).windowsPty,
    ).toEqual({ backend: "conpty", buildNumber: 19_045 });
    expect(
      mergeTerminalOptions(
        { documentOverride: null, windowsPty: { backend: "winpty" } },
        baseDefaults,
        backendOptions,
      ).windowsPty,
    ).toEqual({ backend: "conpty", buildNumber: 19_045 });
  });

  it("leaves the build number out when neither source has one", () => {
    const result = mergeTerminalOptions(
      { documentOverride: null },
      baseDefaults,
      { platform: "win32", win32Backend: "conpty" },
    );

    expect(result.windowsPty).toEqual({ backend: "conpty" });
    expect(result.windowsPty).not.toHaveProperty("buildNumber");
  });

  it("clears ConPTY renderer hints for the legacy backend on Windows", () => {
    const result = mergeTerminalOptions(
      {
        documentOverride: null,
        windowsPty: { backend: "conpty", buildNumber: 22_631 },
      },
      {
        ...baseDefaults,
        windowsPty: { backend: "conpty", buildNumber: 19_045 },
      },
      { platform: "win32", win32Backend: "legacy", win32BuildNumber: 19_045 },
    );

    expect(result.windowsPty).toBeUndefined();
  });

  it("does not set a Windows renderer hint on another platform", () => {
    const result = mergeTerminalOptions(
      { documentOverride: null },
      baseDefaults,
      { platform: "darwin", win32Backend: "conpty" },
    );

    expect(result.windowsPty).toBeUndefined();
  });

  it("lets a global link handler replace the default", () => {
    const activate = vi.fn<ILinkHandler["activate"]>();
    const result = mergeTerminalOptions(
      { documentOverride: null },
      { documentOverride: null, linkHandler: { activate } },
    );
    // merged values are deep clones, so compare the callback rather than the wrapper
    expect(result.linkHandler).not.toBe(DEFAULT_LINK_HANDLER);
    expect(result.linkHandler?.activate).toBe(activate);
  });

  it("lets a profile link handler override the global one", () => {
    const globalActivate = vi.fn<ILinkHandler["activate"]>(),
      profileActivate = vi.fn<ILinkHandler["activate"]>();
    const result = mergeTerminalOptions(
      { documentOverride: null, linkHandler: { activate: profileActivate } },
      { documentOverride: null, linkHandler: { activate: globalActivate } },
    );
    expect(result.linkHandler?.activate).toBe(profileActivate);
  });

  it("returns a new object without mutating inputs and is writable", () => {
    const prof = { documentOverride: null, fontFamily: "baz" };
    const globals = { documentOverride: null, fontFamily: "foo" };
    const result = mergeTerminalOptions(prof, globals);
    expect(result).not.toBe(prof);
    expect(result).not.toBe(globals);
    // inputs still unchanged
    expect(prof.fontFamily).toBe("baz");
    expect(globals.fontFamily).toBe("foo");
    // writable: should be able to mutate returned value
    result.fontFamily = "new";
    expect(result.fontFamily).toBe("new");
  });

  describe("parseWin32BuildNumber", () => {
    it("takes the third component of the OS release", () => {
      expect(parseWin32BuildNumber("10.0.19045")).toBe(19_045);
      expect(parseWin32BuildNumber("10.0.26100")).toBe(26_100);
    });

    it("ignores a missing, non-numeric, or non-positive build", () => {
      expect(parseWin32BuildNumber("")).toBeUndefined();
      expect(parseWin32BuildNumber("10.0")).toBeUndefined();
      expect(parseWin32BuildNumber("10.0.x")).toBeUndefined();
      expect(parseWin32BuildNumber("10.0.")).toBeUndefined();
      expect(parseWin32BuildNumber("10.0.0")).toBeUndefined();
      expect(parseWin32BuildNumber("10.0.-1")).toBeUndefined();
      expect(parseWin32BuildNumber("10.0.19045abc")).toBeUndefined();
      expect(parseWin32BuildNumber("24.6.0-darwin")).toBeUndefined();
    });
  });

  describe("settleConsoleHostBackendOptions", () => {
    const windows10 = {
        platform: "win32",
        win32Backend: "conpty",
        win32BuildNumber: 19_045,
      } as const,
      OPENCONSOLE = { engine: "openconsole" } as const,
      CONHOST = { engine: "conhost" } as const,
      noOptions = { documentOverride: null };

    it("names the build from which xterm.js reflows a ConPTY terminal", () => {
      // xterm.js 6 reflows and drops its wrap guesses from this build on.
      expect(CONPTY_REFLOW_BUILD_NUMBER).toBe(21_376);
    });

    it("raises a Windows 10 build to 21376 on Windows Terminal's console host", () => {
      const settled = settleConsoleHostBackendOptions(windows10, OPENCONSOLE);

      expect(settled).toEqual({ ...windows10, win32BuildNumber: 21_376 });
      expect(Object.isFrozen(settled)).toBe(true);
      expect(
        mergeTerminalOptions(noOptions, noOptions, settled).windowsPty,
      ).toEqual({ backend: "conpty", buildNumber: 21_376 });
    });

    it.each<TerminalBackendOptions>([
      // A newer build already reflows.
      { ...windows10, win32BuildNumber: 26_100 },
      { ...windows10, win32BuildNumber: 21_376 },
      // An unknown build sets no build number, and xterm.js then reflows.
      { ...windows10, win32BuildNumber: void 0 },
      // The ConHost backend has no ConPTY hint at all.
      { ...windows10, win32Backend: "legacy" },
      // ConPTY runs only on Windows.
      { ...windows10, platform: "darwin" },
      { ...windows10, platform: "linux" },
    ])("keeps the options %j", (backendOptions) => {
      expect(settleConsoleHostBackendOptions(backendOptions, OPENCONSOLE)).toBe(
        backendOptions,
      );
    });

    it("keeps the machine's build on the console host built into Windows", () => {
      expect(settleConsoleHostBackendOptions(windows10, CONHOST)).toBe(
        windows10,
      );
    });

    it("leaves another platform's options without a Windows hint", () => {
      const settled = settleConsoleHostBackendOptions(
        { ...windows10, platform: "darwin" },
        OPENCONSOLE,
      );

      expect(
        mergeTerminalOptions(noOptions, noOptions, settled).windowsPty,
      ).toBeUndefined();
    });

    it.each([
      ["profile", { windowsPty: { buildNumber: 19_045 } }, {}],
      ["global", {}, { windowsPty: { buildNumber: 19_045 } }],
    ] as const)(
      "lets a build number set in the %s terminal options win",
      (_source, profileOptions, globalOptions) => {
        const settled = settleConsoleHostBackendOptions(windows10, OPENCONSOLE);

        expect(
          mergeTerminalOptions(
            { ...noOptions, ...profileOptions },
            { ...noOptions, ...globalOptions },
            settled,
          ).windowsPty,
        ).toEqual({ backend: "conpty", buildNumber: 19_045 });
      },
    );

    it("keeps the raised build through a later settings change", () => {
      // The live-update path patches the terminal with the difference of two
      // merges, so only a change that moves `windowsPty` assigns it: here the
      // removal of a build number that also reflows. The patch must merge
      // with the settled options; the machine's build would stop reflowing.
      const settled = settleConsoleHostBackendOptions(windows10, OPENCONSOLE),
        before = { ...noOptions, windowsPty: { buildNumber: 22_621 } },
        changed = { ...noOptions, fontSize: 14 },
        patch = (
          backendOptions: TerminalBackendOptions,
        ): { fontSize?: unknown; windowsPty?: unknown } => {
          const term = { options: {} } as Terminal & {
            options: { fontSize?: unknown; windowsPty?: unknown };
          };
          applyTerminalOptionDiffShallow(
            term,
            mergeTerminalOptions(noOptions, before, backendOptions),
            mergeTerminalOptions(noOptions, changed, backendOptions),
          );
          return term.options;
        };

      expect(patch(settled)).toEqual({
        fontSize: 14,
        windowsPty: { backend: "conpty", buildNumber: 21_376 },
      });
      expect(patch(windows10).windowsPty).toEqual({
        backend: "conpty",
        buildNumber: 19_045,
      });
    });

    describe("consoleHostMayRaiseBuild", () => {
      it("is true for a Windows 10 build without a build number in the options", () => {
        expect(consoleHostMayRaiseBuild(noOptions, noOptions, windows10)).toBe(
          true,
        );
      });

      it.each<TerminalBackendOptions>([
        { ...windows10, win32BuildNumber: 26_100 },
        { ...windows10, win32BuildNumber: 21_376 },
        { ...windows10, win32BuildNumber: void 0 },
        { ...windows10, win32Backend: "legacy" },
        { ...windows10, platform: "darwin" },
        { ...windows10, platform: "linux" },
      ])("is false for the options %j", (backendOptions) => {
        expect(
          consoleHostMayRaiseBuild(noOptions, noOptions, backendOptions),
        ).toBe(false);
      });

      it.each([
        ["profile", { windowsPty: { buildNumber: 19_045 } }, {}],
        ["global", {}, { windowsPty: { buildNumber: 19_045 } }],
      ] as const)(
        "is false with a build number in the %s terminal options",
        (_source, profileOptions, globalOptions) => {
          expect(
            consoleHostMayRaiseBuild(
              { ...noOptions, ...profileOptions },
              { ...noOptions, ...globalOptions },
              windows10,
            ),
          ).toBe(false);
        },
      );

      it("is true when the profile's windowsPty without a build number replaces a global one", () => {
        // The merge is shallow: the profile's object hides the global build.
        expect(
          consoleHostMayRaiseBuild(
            { ...noOptions, windowsPty: {} },
            { ...noOptions, windowsPty: { buildNumber: 19_045 } },
            windows10,
          ),
        ).toBe(true);
      });
    });
  });

  describe("applyTerminalOptionDiffShallow", () => {
    it("updates changed first-level properties and ignores identical ones", () => {
      const term = { options: {} } as Terminal & {
        options: { a?: unknown; b?: unknown; c?: unknown };
      };
      const prev = { documentOverride: null, a: 1, b: { x: 2 } };
      const cur = { documentOverride: null, a: 1, b: { x: 3 }, c: "new" };
      term.options.a = prev.a;
      term.options.b = prev.b;

      applyTerminalOptionDiffShallow(term, prev, cur);
      expect(term.options.a).toBe(1); // unchanged
      expect(term.options.b).toEqual({ x: 3 }); // replaced whole object
      expect(term.options.c).toBe("new"); // added
    });

    it("removes keys that disappear in the new options", () => {
      const term = { options: { foo: "bar", keep: true } } as Terminal & {
        options: { foo?: unknown; keep?: unknown };
      };
      const prev = { documentOverride: null, foo: "bar", keep: true };
      const cur = { documentOverride: null, keep: true };
      applyTerminalOptionDiffShallow(term, prev, cur);
      expect(term.options.foo).toBeUndefined();
      expect(term.options.keep).toBe(true);
    });

    it("does not mutate nested objects beyond first level", () => {
      const term = { options: {} } as Terminal & {
        options: { nested?: unknown };
      };
      const prev = { documentOverride: null, nested: { inner: { val: 1 } } };
      const cur = { documentOverride: null, nested: { inner: { val: 1 } } };
      applyTerminalOptionDiffShallow(term, prev, cur);
      // should not change because deep equal
      expect(term.options.nested).toBeUndefined();
    });
  });
});
