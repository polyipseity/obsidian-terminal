import { PATHS, PLUGIN_ID } from "./utils.mjs";
import { copyFile, mkdir } from "node:fs/promises";
import { argv } from "node:process";

const ARGV_DESTINATION = 2;

// Resolve plugin id and handle missing/invalid manifests with a concise
// error message so calling processes receive a clean failure without
// a full stack trace printed to stderr.
let pluginId;
try {
  pluginId = await PLUGIN_ID;
} catch (err) {
  console.error(
    "Error reading manifest.json:",
    err && err.message ? err.message : String(err),
  );
  // Exit with non-zero so callers can assert failure without the stack trace.
  process.exit(1);
}

const DESTINATION_PREFIX = `${PATHS.obsidianPlugins}/${pluginId}`,
  DESTINATION = `${argv[ARGV_DESTINATION] ?? "."}/${DESTINATION_PREFIX}`;

await mkdir(DESTINATION, { recursive: true });
await Promise.all(
  [PATHS.manifest, PATHS.main, PATHS.styles].map((file) =>
    copyFile(file, `${DESTINATION}/${file}`),
  ),
);
