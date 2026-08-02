import { PATHS, execute } from "./utils.mjs";
import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";

const PackageSchema = v.object({
    author: v.optional(v.string()),
    description: v.optional(v.string()),
    funding: v.optional(
      v.array(v.object({ type: v.string(), url: v.string() })),
    ),
    version: v.string(),
    obsidian: v.objectWithRest({ minAppVersion: v.string() }, v.unknown()),
  }),
  VersionsSchema = v.record(v.string(), v.string()),
  ObjectSchema = v.record(v.string(), v.unknown());

const BETA_MANIFEST = Object.freeze({ version: "rolling" }),
  aPackage = readFile(PATHS.package, "utf-8").then((data) =>
    v.parse(PackageSchema, JSON.parse(data)),
  ),
  aVersions = readFile(PATHS.versions, "utf-8").then((data) =>
    v.parse(VersionsSchema, JSON.parse(data)),
  );

/**
 * Recursively sort object keys in ascending code-unit order, matching
 * prettier's default order for JSON keys. Arrays and primitives pass through.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
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
function stringifySorted(value) {
  return `${JSON.stringify(sortKeys(value), null, "  ")}\n`;
}

await Promise.all([
  (async () => {
    const pack = await aPackage,
      manifest = {
        ...(pack.author ? { author: pack.author } : {}),
        ...(pack.description ? { description: pack.description } : {}),
        ...(pack.funding
          ? {
              fundingUrl: Object.fromEntries(
                pack.funding.map(({ type, url }) => [type, url]),
              ),
            }
          : {}),
        version: pack.version,
        ...pack.obsidian,
      };
    await Promise.all([
      writeFile(PATHS.manifest, stringifySorted(manifest), {
        encoding: "utf-8",
      }),
      writeFile(
        PATHS.manifestBeta,
        stringifySorted({ ...manifest, ...BETA_MANIFEST }),
        {
          encoding: "utf-8",
        },
      ),
    ]);
  })(),
  (async () => {
    const [pack, versions] = await Promise.all([aPackage, aVersions]);
    versions[pack.version] = pack.obsidian.minAppVersion;
    await writeFile(PATHS.versions, stringifySorted(versions), {
      encoding: "utf-8",
    });
  })(),
]);
await execute(
  "git",
  ["add", PATHS.manifest, PATHS.manifestBeta, PATHS.versions],
  {
    encoding: "utf-8",
  },
);
