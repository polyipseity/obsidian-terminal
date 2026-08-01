/**
 * sync-locale-keys.mjs
 * --------------------
 * Utility script used during development to keep every non-English locale
 * synchronized with the English `translation.json` file.  When new keys are
 * added, renamed or reordered in `assets/locales/en/translation.json` the same
 * keys should exist in all other translations so that translators have a
 * reference file.  This script walks the English tree, copies values over to
 * each other language (overwriting existing entries) and then writes the
 * result back to disk sorted by key.  Sorting makes git diffs meaningful and
 * keeps locale files easy to scan manually.
 *
 * This file is a standalone ES module (`.mjs`) so that the project can simply
 * execute it with `node scripts/sync-locale-keys.mjs` regardless of the
 * `package.json` "type" field.  It also allows use of `import`/`export` and
 * `async`/`await` without flags.
 *
 * Usage:
 *   node scripts/sync-locale-keys.mjs       # can be run from any working
 *                                           # directory; it locates itself
 *                                           # via `import.meta.url`
 *
 * There is no external dependency; the script only uses the built‑in `fs` and
 * `path` modules.  It deliberately avoids mutating the English file and
 * ignores directories that lack a `translation.json`.
 *
 * This script is intended to be run manually (or via a bun script) whenever
 * translation keys are added or modified.  It is *not* run as part of the
 * build pipeline, but keeping it in `scripts/` and referenced in the repo
 * documentation makes it a formal part of our workflow.
 */

import fs from "node:fs/promises";
import path from "node:path";

// These variables need to be computed at runtime rather than at module load
// time.  By default we derive paths relative to the location of this script so
// that the utility works regardless of the current working directory.  Tests
// can override by passing an explicit `rootDir` argument to `main`.
import { fileURLToPath } from "url";

import * as v from "valibot";

function makePaths(/** @type {string} */ rootDir) {
  // `rootDir`, if provided, should be the project root containing the
  // `assets` directory.  Otherwise we derive the repo root from the location
  // of this script (which lives under `<repo>/scripts`).
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = rootDir ? path.resolve(rootDir) : path.dirname(scriptDir);
  const localesDir = path.join(repoRoot, "assets", "locales");
  const enPath = path.join(localesDir, "en", "translation.json");
  return { localesDir, enPath };
}

/**
 *
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readJSON(filePath) {
  return v.parse(
    v.pipe(v.string(), v.parseJson()),
    await fs.readFile(filePath, "utf-8"),
  );
}

/**
 *
 * @param {string} filePath
 * @param {unknown} obj
 * @returns {Promise<void>}
 */
async function writeJson(filePath, obj) {
  // sort prior to serialization so disk output is deterministic
  const sorted = sortObject(obj);
  await fs.writeFile(filePath, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
}

/**
 * Recursively sorts the keys of an object.  Arrays and non-object values are
 * returned unchanged.  This is a pure function that returns a new object.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortObject(value) {
  if (Array.isArray(value)) {
    const /** @type {unknown[]} */ ret = value.slice();
    return ret;
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortObject(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Merge keys from `source` into `target` in place.  If a value is an object
 * (but not an array) we recurse; otherwise we copy the source value over the
 * target, overwriting whatever was there.
 *
 * @param {Record<string, unknown>} source
 * @param {Record<string, unknown>} target
 * @returns {Record<string, unknown>}
 */
function merge(source, target) {
  // Add or merge keys from `source` into `target`, handling "variant"
  // groups: keys with a shared prefix before the first underscore.  When any
  // member of a group exists in the translation, we treat the group as
  // satisfied and do not introduce other members.  After merging we also
  // remove any groups whose base prefix no longer exists in the source.

  // helper to determine the base portion of a key
  const baseOf = (/** @type {string} */ k) => k.split("_")[0];

  // build set of existing bases in target
  const targetBases = new Set(Object.keys(target).map(baseOf));

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const base = baseOf(key);

    // if any key sharing the base already exists, we skip adding new members
    // of that group.  However, if the exact key exists and both values are
    // objects we still recurse to merge children.
    if (targetBases.has(base)) {
      if (
        key in target &&
        srcVal &&
        typeof srcVal === "object" &&
        !Array.isArray(srcVal) &&
        target[key] &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
      ) {
        merge(srcVal, target[key]);
      }
      continue;
    }

    // no member of this base group exists; copy the key/value
    if (srcVal && typeof srcVal === "object" && !Array.isArray(srcVal)) {
      target[key] = merge(srcVal, {});
    } else {
      if (!(key in target)) {
        target[key] = srcVal;
      }
    }
    targetBases.add(base); // newly added group satisfies base
  }

  // prune any groups whose base is not present in the source
  const sourceBases = new Set(Object.keys(source).map(baseOf));
  for (const key of Object.keys(target)) {
    const base = baseOf(key);
    if (!sourceBases.has(base)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- clean up translated keys not in source
      delete target[key];
    }
  }

  return target;
}

/**
 *
 * @param {string} rootDir
 * @returns {Promise<void>}
 */
async function main(rootDir) {
  const { localesDir, enPath } = makePaths(rootDir);

  try {
    await fs.access(enPath);
  } catch {
    console.error(`English file not found at ${enPath}`);
    process.exit(1);
  }

  const enData = await readJSON(enPath);

  for (const entry of await fs.readdir(localesDir)) {
    const subdir = path.join(localesDir, entry);
    if (!(await fs.stat(subdir)).isDirectory()) continue;
    if (entry === "en") continue;

    const file = path.join(subdir, "translation.json");
    try {
      await fs.access(file);
    } catch {
      continue;
    }

    const data = await readJSON(file);
    merge(enData, data);
    await writeJson(file, data);
    console.log(`updated ${file}`);
  }

  console.log("sync complete");
}

export { main };

// if this module is evaluated as the entrypoint, run the main function.
// we compare the resolved file URL to `process.argv[1]` so that running
// `node scripts/sync-locale-keys.mjs` from anywhere triggers execution.  This
// also leaves `main` exported for tests and other callers.
{
  const { fileURLToPath } = await import("url");
  const scriptFile = fileURLToPath(import.meta.url);
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
    main().catch((/** @type {unknown} */ error) => {
      console.error(
        "Error syncing locale keys:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
  }
}
