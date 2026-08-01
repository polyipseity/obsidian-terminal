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
  VersionsSchema = v.record(v.string(), v.string());

const BETA_MANIFEST = Object.freeze({ version: "rolling" }),
  aPackage = readFile(PATHS.package, "utf-8").then((data) =>
    v.parse(PackageSchema, JSON.parse(data)),
  ),
  aVersions = readFile(PATHS.versions, "utf-8").then((data) =>
    v.parse(VersionsSchema, JSON.parse(data)),
  );

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
      writeFile(PATHS.manifest, JSON.stringify(manifest, null, "  "), {
        encoding: "utf-8",
      }),
      writeFile(
        PATHS.manifestBeta,
        JSON.stringify({ ...manifest, ...BETA_MANIFEST }, null, "  "),
        {
          encoding: "utf-8",
        },
      ),
    ]);
  })(),
  (async () => {
    const [pack, versions] = await Promise.all([aPackage, aVersions]);
    versions[pack.version] = pack.obsidian.minAppVersion;
    await writeFile(PATHS.versions, JSON.stringify(versions, null, "  "), {
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
