import { describe, it, expect, vi } from "vitest";
import {
  mergeTerminalOptions,
  applyTerminalOptionDiffShallow,
  parseWin32BuildNumber,
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
