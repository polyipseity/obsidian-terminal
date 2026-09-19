import { describe, it, expect, vi } from "vitest";
import {
  mergeTerminalOptions,
  applyTerminalOptionDiffShallow,
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
