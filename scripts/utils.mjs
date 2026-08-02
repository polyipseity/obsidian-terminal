import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import PLazy from "p-lazy";
import * as v from "valibot";

const ManifestJson = v.pipe(
    v.string(),
    v.parseJson(),
    v.object({ id: v.string() }),
  ),
  ObjectSchema = v.record(v.string(), v.unknown());

const execFileP = promisify(execFile),
  OUTDIR = ".";

export const PATHS = Object.freeze({
    main: `${OUTDIR}/main.js`,
    manifest: "manifest.json",
    manifestBeta: "manifest-beta.json",
    metafile: "metafile.json",
    obsidianPlugins: ".obsidian/plugins",
    outDir: OUTDIR,
    package: "package.json",
    packageLock: "package-lock.json",
    styles: `${OUTDIR}/styles.css`,
    versions: "versions.json",
  }),
  PLUGIN_ID = PLazy.from(
    async () =>
      v.parse(
        ManifestJson,
        await readFile(PATHS.manifest, { encoding: "utf-8" }),
      ).id,
  );

/**
 *
 * @param  {...unknown} args
 * @returns {Promise<string>}
 */
export async function execute(...args) {
  const process = execFileP(...args),
    { stdout, stderr } = await process;
  if (stdout) {
    console.log(stdout);
  }
  if (stderr) {
    console.error(stderr);
  }
  const { exitCode } = process.child;
  if (exitCode !== 0) {
    throw new Error(String(exitCode));
  }
  return stdout;
}

/**
 * Recursively sort object keys in ascending code-unit order, matching
 * prettier's default order for JSON keys. Arrays and primitives pass through.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(v.parse(ObjectSchema, value))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

/**
 * Stringify JSON with sorted keys and a trailing newline, matching prettier
 * output.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stringifySorted(value) {
  return `${JSON.stringify(sortKeys(value), null, "  ")}\n`;
}

/**
 * Parse a UTF-8 JSON file.
 *
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
export async function readJSON(filePath) {
  return v.parse(
    v.pipe(v.string(), v.parseJson()),
    await readFile(filePath, "utf-8"),
  );
}

/**
 * Write an object to a UTF-8 JSON file with sorted keys and a trailing
 * newline, matching prettier output.
 *
 * @param {string} filePath
 * @param {unknown} obj
 * @returns {Promise<void>}
 */
export async function writeJSON(filePath, obj) {
  await writeFile(filePath, stringifySorted(obj), "utf-8");
}
