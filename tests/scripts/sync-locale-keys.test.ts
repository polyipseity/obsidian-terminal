// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

// This integration test exercises the sync-locale-keys.mjs script on a temporary
// locale directory tree.  It verifies that keys are copied from the English
// file to an existing translation, that sorting is applied, and that files with
// missing translation.json are ignored.

async function importScript() {
  return await import("../../scripts/sync-locale-keys.mjs");
}

describe("scripts/sync-locale-keys.mjs", () => {
  let tmpdir: string;
  let origCwd: string;
  let logSpy: MockInstance;
  let errorSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(async () => {
    origCwd = process.cwd();
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "locales-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      // Simulate process.exit but make it observable without terminating the
      // test runner.
      throw new Error(`process.exit called with ${String(code)}`);
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    process.chdir(origCwd);
    await fs.rm(tmpdir, { recursive: true, force: true });
  });

  it("copies keys and sorts result", async () => {
    // create minimal repo structure inside tmpdir.  we no longer rely on cwd
    // inside the script; instead we pass `tmpdir` explicitly when invoking
    // `main`.
    const localesDir = path.join(tmpdir, "assets", "locales");
    await fs.mkdir(localesDir, { recursive: true });

    const enDir = path.join(localesDir, "en");
    const frDir = path.join(localesDir, "fr");
    await fs.mkdir(enDir, { recursive: true });
    await fs.mkdir(frDir, { recursive: true });

    const enData = {
      b: "second",
      a: {
        z: "nested-z",
        y: "nested-y",
      },
      c: "third",
    };
    await fs.writeFile(
      path.join(enDir, "translation.json"),
      JSON.stringify(enData, null, 2),
    );

    // french file already has some keys in wrong order and a stale value
    const frData = {
      c: "troisieme",
      a: {
        y: "ancien",
      },
    };
    await fs.writeFile(
      path.join(frDir, "translation.json"),
      JSON.stringify(frData, null, 2),
    );

    // run the script
    const { main } = await importScript();
    await main(tmpdir);

    const result = v.parse(
      v.record(v.string(), v.unknown()),
      v.parse(
        v.pipe(v.string(), v.parseJson()),
        await fs.readFile(path.join(frDir, "translation.json"), "utf-8"),
      ),
    );

    // after sync the french file should reflect english structure
    expect(result).toEqual({
      a: {
        y: "ancien", // original translation preserved
        z: "nested-z", // new key added from English
      },
      b: "second", // new key added from English
      c: "troisieme", // existing translation untouched
    });

    expect(logSpy).toHaveBeenCalledWith(
      `updated ${path.join(frDir, "translation.json")}`,
    );
    expect(logSpy).toHaveBeenCalledWith("sync complete");

    // verify keys are sorted at each level
    const keys = Object.keys(result);
    expect(keys).toEqual(["a", "b", "c"]);
    const aValue: unknown = result.a;
    expect(
      aValue !== null && typeof aValue === "object" && Object.keys(aValue),
    ).toEqual(["y", "z"]);

    // shared writeJSON appends a trailing newline, matching prettier output
    expect(
      await fs.readFile(path.join(frDir, "translation.json"), "utf-8"),
    ).toMatch(/\n$/);
  });

  it("escapes invisible characters when writing translation files", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    await fs.mkdir(localesDir, { recursive: true });

    const enDir = path.join(localesDir, "en");
    const frDir = path.join(localesDir, "fr");
    await fs.mkdir(enDir, { recursive: true });
    await fs.mkdir(frDir, { recursive: true });

    await fs.writeFile(
      path.join(enDir, "translation.json"),
      JSON.stringify({ intro: "a\u00a0b" }, null, 2),
    );
    await fs.writeFile(path.join(frDir, "translation.json"), "{}");

    const { main } = await importScript();
    await main(tmpdir);

    const raw = await fs.readFile(
      path.join(frDir, "translation.json"),
      "utf-8",
    );
    // the saved file contains the literal escape sequence, not the raw NBSP
    expect(raw).toContain("a\\u00a0b");
    expect(raw).not.toContain("a\u00a0b");
    // and still parses back to the original value
    expect(
      v.parse(
        v.record(v.string(), v.unknown()),
        v.parse(v.pipe(v.string(), v.parseJson()), raw),
      ),
    ).toEqual({ intro: "a\u00a0b" });
  });

  it("ignores directories without translation.json", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    await fs.mkdir(path.join(localesDir, "en"), { recursive: true });
    await fs.writeFile(path.join(localesDir, "en", "translation.json"), "{}");
    await fs.mkdir(path.join(localesDir, "es")); // no translation.json

    // should not throw
    const { main } = await importScript();
    await main(tmpdir);

    // no "updated" call since `es` has no translation.json
    expect(logSpy).toHaveBeenCalledWith("sync complete");
  });

  it("treats base key and variants as a group when adding", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    await fs.mkdir(localesDir, { recursive: true });

    const enDir = path.join(localesDir, "en");
    const frDir = path.join(localesDir, "fr");
    await fs.mkdir(enDir, { recursive: true });
    await fs.mkdir(frDir, { recursive: true });

    const enData = {
      spawn: "to spawn",
      spawn_gerund: "spawning",
      other: "value",
    };
    await fs.writeFile(
      path.join(enDir, "translation.json"),
      JSON.stringify(enData, null, 2),
    );

    // french file already has the variant but not the base
    const frData = {
      spawn_gerund: "exist",
    };
    await fs.writeFile(
      path.join(frDir, "translation.json"),
      JSON.stringify(frData, null, 2),
    );

    const { main } = await importScript();
    await main(tmpdir);

    const result = v.parse(
      v.record(v.string(), v.unknown()),
      v.parse(
        v.pipe(v.string(), v.parseJson()),
        await fs.readFile(path.join(frDir, "translation.json"), "utf-8"),
      ),
    );
    // since the variant existed, the base should NOT have been added
    expect(result).toEqual({
      spawn_gerund: "exist",
      other: "value",
    });

    expect(logSpy).toHaveBeenCalledWith(
      `updated ${path.join(frDir, "translation.json")}`,
    );
    expect(logSpy).toHaveBeenCalledWith("sync complete");
  });

  it("removes group when base is deleted from English", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    await fs.mkdir(localesDir, { recursive: true });
    const enDir = path.join(localesDir, "en");
    const frDir = path.join(localesDir, "fr");
    await fs.mkdir(enDir, { recursive: true });
    await fs.mkdir(frDir, { recursive: true });

    // english has no spawn keys at all
    await fs.writeFile(
      path.join(enDir, "translation.json"),
      JSON.stringify({ other: "x" }, null, 2),
    );

    const frData = {
      spawn: "foo",
      spawn_gerund: "bar",
      other: "baz",
    };
    await fs.writeFile(
      path.join(frDir, "translation.json"),
      JSON.stringify(frData, null, 2),
    );

    const { main } = await importScript();
    await main(tmpdir);

    const result = v.parse(
      v.record(v.string(), v.unknown()),
      v.parse(
        v.pipe(v.string(), v.parseJson()),
        await fs.readFile(path.join(frDir, "translation.json"), "utf-8"),
      ),
    );
    expect(result).toEqual({ other: "baz" });

    expect(logSpy).toHaveBeenCalledWith(
      `updated ${path.join(frDir, "translation.json")}`,
    );
    expect(logSpy).toHaveBeenCalledWith("sync complete");
  });

  it("exits with error when English translation.json is missing", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    await fs.mkdir(localesDir, { recursive: true });
    // no en/translation.json created

    const { main } = await importScript();
    await expect(main(tmpdir)).rejects.toThrow("process.exit called with 1");

    expect(errorSpy).toHaveBeenCalledWith(
      `English file not found at ${path.join(
        localesDir,
        "en",
        "translation.json",
      )}`,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
