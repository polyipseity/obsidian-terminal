import { PATHS, execute, readJSON, writeJSON } from "./utils.mjs";
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
  aPackage = readJSON(PATHS.package).then((data) =>
    v.parse(PackageSchema, data),
  ),
  aVersions = readJSON(PATHS.versions).then((data) =>
    v.parse(VersionsSchema, data),
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
      writeJSON(PATHS.manifest, manifest),
      writeJSON(PATHS.manifestBeta, { ...manifest, ...BETA_MANIFEST }),
    ]);
  })(),
  (async () => {
    const [pack, versions] = await Promise.all([aPackage, aVersions]);
    versions[pack.version] = pack.obsidian.minAppVersion;
    await writeJSON(PATHS.versions, versions);
  })(),
]);
await execute(
  "git",
  ["add", PATHS.manifest, PATHS.manifestBeta, PATHS.versions],
  {
    encoding: "utf-8",
  },
);
