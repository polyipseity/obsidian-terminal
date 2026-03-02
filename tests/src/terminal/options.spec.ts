import { describe, it, expect } from "vitest";
import { mergeTerminalOptions } from "../../../src/terminal/options.js";
import { Settings } from "../../../src/settings-data.js";

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
  });

  it("allows profile values to override globals", () => {
    const prof = { documentOverride: null, fontFamily: "bar" };
    const result = mergeTerminalOptions(prof, baseDefaults);
    expect(result.fontFamily).toBe("bar");
    // unspecified keys should still come from globals
    expect(result.fontSize).toBe(12);
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
});
