import { PATHS, execute } from "./util.mjs";
import { readFile, writeFile } from "node:fs/promises";

const MANIFEST_MAP = Object.freeze({
    author: ({ author }) => author,
    description: ({ description }) => description,
    fundingUrl: ({ funding }) =>
      funding
        ? Object.fromEntries(funding.map(({ type, url }) => [type, url]))
        : null,
    version: ({ version }) => version,
  }),
  BETA_MANIFEST = Object.freeze({ version: "rolling" }),
  aPackage = readFile(PATHS.package, "utf-8").then((data) => JSON.parse(data)),
  aVersions = readFile(PATHS.versions, "utf-8").then((data) =>
    JSON.parse(data),
  );

await Promise.all([
  (async () => {
    const pack = await aPackage,
      manifest = {
        ...Object.fromEntries(
          Object.entries(MANIFEST_MAP)
            .map(([key, value]) => [key, value(pack)])
            .filter(([, value]) => value),
        ),
        ...pack.obsidian,
      };
    await Promise.all([
      writeFile(PATHS.manifest, JSON.stringify(manifest, null, "\t"), {
        encoding: "utf-8",
      }),
      writeFile(
        PATHS.manifestBeta,
        JSON.stringify({ ...manifest, ...BETA_MANIFEST }, null, "\t"),
        {
          encoding: "utf-8",
        },
      ),
    ]);
  })(),
  (async () => {
    const [pack, versions] = await Promise.all([aPackage, aVersions]);
    versions[MANIFEST_MAP.version(pack)] = pack.obsidian.minAppVersion;
    await writeFile(PATHS.versions, JSON.stringify(versions, null, "\t"), {
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
