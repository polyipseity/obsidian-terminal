/**
 * Source scan for `src/experiments.ts`: feature code reaches the stored flags
 * only through the gate. Reads the file system, hence a `*.test.ts` file.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src"),
  // The registry and gate, the fixer's caller, and the settings section.
  ALLOWED: readonly string[] = [
    "experiments.ts",
    "settings-data.ts",
    "settings.ts",
  ],
  STORED_FLAGS = /\bexperiments\b/u;

/**
 * Drops the lines that end an import from the gate's module, also when the
 * import spans several lines. What is left must not name the stored flags.
 */
function withoutGateImports(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.includes('experiments.js"'))
    .join("\n");
}

describe("src/experiments.ts as the single entrance", () => {
  it("only the settings code touches the stored flags", async () => {
    const files = (await readdir(SRC, { recursive: true }))
        .map((file) => file.split(sep).join("/"))
        .filter(
          (file) => /\.(?:ts|svelte)$/u.test(file) && !ALLOWED.includes(file),
        ),
      scanned = await Promise.all(
        files.map(async (file) => ({
          file: `src/${file}`,
          found: STORED_FLAGS.test(
            withoutGateImports(await readFile(join(SRC, file), "utf8")),
          ),
        })),
      ),
      offenders = scanned.filter(({ found }) => found).map(({ file }) => file);
    expect(files.length).toBeGreaterThan(0);
    expect(
      offenders,
      'These files name "experiments" outside an import from experiments.js. ' +
        "Feature code calls isExperimentEnabled or whileExperimentEnabled and " +
        'never reads the stored flags. In a comment, write "experimental features".',
    ).toEqual([]);
  });

  it("the scan skips an import from the gate and sees every other use", () => {
    expect(
      withoutGateImports(
        [
          "import {",
          "  isExperimentEnabled,",
          '} from "./experiments.js";',
          'import { whileExperimentEnabled } from "../experiments.js";',
        ].join("\n"),
      ),
    ).not.toMatch(STORED_FLAGS);
    expect(
      withoutGateImports("const on = settings.value.experiments.alpha;"),
    ).toMatch(STORED_FLAGS);
    expect(withoutGateImports("// Reads the experiments directly.")).toMatch(
      STORED_FLAGS,
    );
  });
});
