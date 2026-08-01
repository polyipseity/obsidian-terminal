import { analyzeMetafile, context, formatMessages } from "esbuild";
import esbuildCompress from "esbuild-compress";
import esbuildPluginGlobals from "esbuild-plugin-globals";
import esbuildPluginTextReplace from "esbuild-plugin-text-replace";
import { rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { argv } from "node:process";
import { PATHS } from "./utils.mjs";

const ARGV_PRODUCTION = 2,
  COMMENT =
    "// repository: https://github.com/polyipseity/obsidian-plugin-template",
  DEV = argv[ARGV_PRODUCTION] === "dev";

async function esbuild() {
  const build = await context({
    alias: {},
    banner: { js: COMMENT },
    bundle: true,
    color: true,
    drop: [],
    entryPoints: ["src/main.ts", "src/styles.css"],
    external: [
      "@codemirror/*",
      "@lezer/*",
      "electron",
      "node:*",
      "obsidian",
      ...builtinModules,
    ],
    footer: { js: COMMENT },
    format: "cjs",
    inject: ["@polyipseity/obsidian-plugin-library/inject"],
    jsx: "transform",
    legalComments: "inline",
    loader: {},
    logLevel: "info",
    logLimit: 0,
    metafile: true,
    minify: !DEV,
    outdir: PATHS.outDir,
    platform: "browser",
    plugins: [
      esbuildPluginGlobals({
        // Cannot use `i18next` because it is too outdated to have formatters
        moment: "moment",
      }),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- JSDoc typings could be not parsed for some reason.
      esbuildCompress({
        compressors: [
          {
            filter: /\.json$/,
            loader: "json",
          },
          {
            filter: /\.md$/,
            lazy: true,
            loader: "text",
          },
        ],
      }),
      esbuildPluginTextReplace({
        include: /obsidian-plugin-library.*\.js$/,
        pattern: [
          [/\/\/(?<c>[@#]) sourceMappingURL=/gu, "//$1 sourceMappingURL= "],
        ],
      }),
    ],
    sourcemap: DEV && "inline",
    sourcesContent: true,
    target: "ES2018",
    treeShaking: true,
  });

  if (DEV) {
    await build.watch({});
    return;
  }

  try {
    // Await https://github.com/evanw/esbuild/issues/2886
    const { errors, warnings, metafile } = await build.rebuild();
    await Promise.all([
      (async () => {
        console.log(
          await analyzeMetafile(metafile, { color: true, verbose: true }),
        );
        if (warnings.length !== 0) {
          console.warn(
            (
              await formatMessages(warnings, { color: true, kind: "warning" })
            ).join("\n"),
          );
        }
        if (errors.length !== 0) {
          console.error(
            (await formatMessages(errors, { color: true, kind: "error" })).join(
              "\n",
            ),
          );
        }
      })(),
      writeFile(PATHS.metafile, JSON.stringify(metafile, null, "  "), {
        encoding: "utf-8",
      }),
    ]);
  } finally {
    await build.dispose();
  }
}

// remove previous build output before starting a new build
try {
  const results = await Promise.allSettled([
    rm(PATHS.main, { force: true, recursive: true }),
    rm(PATHS.styles, { force: true, recursive: true }),
  ]);
  const rejectedReasons = results
    .filter((r) => r.status === "rejected")
    .map((r) => /** @type {unknown} */ (r.reason));
  if (rejectedReasons.length) {
    // throw all errors together so callers can inspect each failure
    throw new AggregateError(
      rejectedReasons,
      "Failed to remove previous build output (one or more errors)",
    );
  }
} catch (err) {
  console.warn(
    "Failed to remove previous build output, proceeding anyway:",
    err,
  );
}
await esbuild();
