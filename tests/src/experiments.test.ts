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
  STORED_FLAGS = /\bexperiments\b/u,
  // `from "<path>/experiments.js"`, `import "<path>/experiments.js"` and
  // `import("<path>/experiments.js")`, up to the closing quote.
  GATE_SPECIFIER =
    /\b(?:from|import)\s*\(?\s*(["'])[^"'\n]*\/experiments\.js\1/gu;

/**
 * Removes the module specifier from every import and re-export of the gate's
 * module: nothing else in such a statement names the stored flags. The rest of
 * the line stays, so what is left must not name them.
 */
function withoutGateImports(source: string): string {
  return source.replace(GATE_SPECIFIER, "");
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
      withoutGateImports('const gate = await import("./experiments.js");'),
    ).not.toMatch(STORED_FLAGS);
    // Naming the gate's module on a line does not hide the rest of the line.
    expect(
      withoutGateImports(
        'const on = settings.value.experiments.tabStatus; // see "./experiments.js"',
      ),
    ).toMatch(STORED_FLAGS);
    expect(
      withoutGateImports(
        'const gate = await import("./experiments.js"), raw = settings.value.experiments;',
      ),
    ).toMatch(STORED_FLAGS);
    expect(
      withoutGateImports("const on = settings.value.experiments.alpha;"),
    ).toMatch(STORED_FLAGS);
    expect(withoutGateImports("// Reads the experiments directly.")).toMatch(
      STORED_FLAGS,
    );
  });
});
