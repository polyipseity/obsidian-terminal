/**
 * Tests for small test utilities in `tests/helpers.ts` — keep these fast and explicit.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeDocView, toRecord, makePluginContext } from "../helpers.js";

describe("tests/helpers.ts utilities", () => {
  it("makeRegisteredDocView returns a view whose open delegates to provided spy", async () => {
    const openSpy = vi.fn().mockResolvedValue(undefined);
    const v = makeDocView({ open: openSpy });
    expect(typeof v.open).toBe("function");
    await v.open();
    expect(openSpy).toHaveBeenCalled();
  });

  it("makeDocView creates a DocView with a spied open by default", async () => {
    const dv = makeDocView();
    await dv.open();
    expect(dv.open).toHaveBeenCalled();
  });

  it("library mock helpers behave as expected (cloneAsWritable, fixInSet, fixTyped, revealPrivate)", async () => {
    const lib = vi.mocked(await import("@polyipseity/obsidian-plugin-library"));

    // cloneAsWritable returns shallow clone for objects
    const src = { a: 1, b: 2 };
    const cloned = lib.cloneAsWritable(src);
    expect(cloned).toEqual(src);
    expect(cloned).not.toBe(src);

    // fixInSet returns matching value if present in set
    const set = ["a", "b"] as const;
    // Use a local-typed shim of the mocked library functions to avoid heavy typing in tests
    const shim = lib;

    expect(shim.fixInSet(toRecord({}), { k: "b" }, "k", set)).toBe("b");
    // returns default when value not present
    expect(shim.fixInSet(toRecord({}), { k: "z" }, "k", set)).toBe("a");

    // fixTyped returns value when types match, otherwise default
    const def = { k: 1 };
    expect(shim.fixTyped(def, { k: 2 }, "k", [])).toBe(2);
    expect(shim.fixTyped(def, { k: "x" }, "k", [])).toBe(1);
  });

  it("revealPrivate and revealPrivateAsync log and fallback on error", async () => {
    const lib = vi.mocked(await import("@polyipseity/obsidian-plugin-library"));
    const ctx = makePluginContext();
    // Ensure `self` exists in the test environment (used by the mock)
    const _oldSelf = globalThis.self;
    globalThis.self = globalThis as (typeof globalThis)["self"];
    const warnSpy = vi
      .spyOn(globalThis.console, "warn")
      .mockImplementation(() => {});

    // sync: fallback on throw and logs
    const r1 = lib.revealPrivate(
      ctx,
      [],
      () => {
        throw new Error("boom");
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_e) => "fb",
    );
    expect(r1).toBe("fb");
    expect(warnSpy).toHaveBeenCalled();

    // sync: success path
    const r2 = lib.revealPrivate(
      ctx,
      [],
      () => "ok",
      () => "fb",
    );
    expect(r2).toBe("ok");

    // async: fallback on throw and logs
    const r3 = await lib.revealPrivateAsync(
      ctx,
      [],
      async () => {
        throw new Error("boom");
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_e) => "afb",
    );
    expect(r3).toBe("afb");
    expect(warnSpy).toHaveBeenCalled();

    // async: success path
    const r4 = await lib.revealPrivateAsync(
      ctx,
      [],
      async () => "aok",
      () => "afb",
    );
    expect(r4).toBe("aok");

    // Restore previous `self` binding if any to avoid polluting global state
    globalThis.self = _oldSelf;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
