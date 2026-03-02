// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// This integration test exercises the sync-locale-keys.mjs script on a temporary
// locale directory tree.  It verifies that keys are copied from the English
// file to an existing translation, that sorting is applied, and that files with
// missing translation.json are ignored.

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "sync-locale-keys.mjs");

describe("scripts/sync-locale-keys.mjs", () => {
  let tmpdir;
  let origCwd;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "locales-"));
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("copies keys and sorts result", async () => {
    // create minimal repo structure inside tmpdir.  we no longer rely on cwd
    // inside the script; instead we pass `tmpdir` explicitly when invoking
    // `main`.
    const localesDir = path.join(tmpdir, "assets", "locales");
    fs.mkdirSync(localesDir, { recursive: true });

    const enDir = path.join(localesDir, "en");
    const frDir = path.join(localesDir, "fr");
    fs.mkdirSync(enDir, { recursive: true });
    fs.mkdirSync(frDir, { recursive: true });

    const enData = {
      b: "second",
      a: {
        z: "nested-z",
        y: "nested-y",
      },
      c: "third",
    };
    fs.writeFileSync(
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
    fs.writeFileSync(
      path.join(frDir, "translation.json"),
      JSON.stringify(frData, null, 2),
    );

    // run the script
    const { main } = await import(SCRIPT_PATH);
    await main(tmpdir);

    const result = JSON.parse(
      fs.readFileSync(path.join(frDir, "translation.json"), "utf-8"),
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

    // verify keys are sorted at each level
    const keys = Object.keys(result);
    expect(keys).toEqual(["a", "b", "c"]);
    expect(Object.keys(result.a)).toEqual(["y", "z"]);
  });

  it("ignores directories without translation.json", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    fs.mkdirSync(path.join(localesDir, "en"), { recursive: true });
    fs.writeFileSync(path.join(localesDir, "en", "translation.json"), "{}");
    fs.mkdirSync(path.join(localesDir, "es")); // no translation.json

    // should not throw
    const { main } = await import(SCRIPT_PATH);
    await main(tmpdir);
  });

  it("treats base key and variants as a group when adding", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    fs.mkdirSync(localesDir, { recursive: true });

    const enDir = path.join(localesDir, "en");
    const frDir = path.join(localesDir, "fr");
    fs.mkdirSync(enDir, { recursive: true });
    fs.mkdirSync(frDir, { recursive: true });

    const enData = {
      spawn: "to spawn",
      spawn_gerund: "spawning",
      other: "value",
    };
    fs.writeFileSync(
      path.join(enDir, "translation.json"),
      JSON.stringify(enData, null, 2),
    );

    // french file already has the variant but not the base
    const frData = {
      spawn_gerund: "exist",
    };
    fs.writeFileSync(
      path.join(frDir, "translation.json"),
      JSON.stringify(frData, null, 2),
    );

    const { main } = await import(SCRIPT_PATH);
    await main(tmpdir);

    const result = JSON.parse(
      fs.readFileSync(path.join(frDir, "translation.json"), "utf-8"),
    );
    // since the variant existed, the base should NOT have been added
    expect(result).toEqual({
      spawn_gerund: "exist",
      other: "value",
    });
  });

  it("removes group when base is deleted from English", async () => {
    const localesDir = path.join(tmpdir, "assets", "locales");
    fs.mkdirSync(localesDir, { recursive: true });
    const enDir = path.join(localesDir, "en");
    const frDir = path.join(localesDir, "fr");
    fs.mkdirSync(enDir, { recursive: true });
    fs.mkdirSync(frDir, { recursive: true });

    // english has no spawn keys at all
    fs.writeFileSync(
      path.join(enDir, "translation.json"),
      JSON.stringify({ other: "x" }, null, 2),
    );

    const frData = {
      spawn: "foo",
      spawn_gerund: "bar",
      other: "baz",
    };
    fs.writeFileSync(
      path.join(frDir, "translation.json"),
      JSON.stringify(frData, null, 2),
    );

    const { main } = await import(SCRIPT_PATH);
    await main(tmpdir);

    const result = JSON.parse(
      fs.readFileSync(path.join(frDir, "translation.json"), "utf-8"),
    );
    expect(result).toEqual({ other: "baz" });
  });
});
