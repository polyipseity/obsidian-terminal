/**
 * Type scan of `src/` and `assets/` as Obsidian's community Scorecard sees
 * them. Its lint reads a source archive of the release, and an archive has no
 * git submodules: `@polyipseity/obsidian-plugin-library` does not resolve, and
 * every type that comes from it is an `error` type that acts as `any`. A union
 * or intersection with such a member is reported as "'any' overrides all other
 * types in this union type" or as an "Unresolved error type".
 *
 * This test type-checks the sources with the library made unresolvable and
 * lists every union or intersection member that becomes `any`:
 * - `(any)`: a type of ours inferred through a library value, such as
 *   `(typeof X)[number]` with `X = deepFreeze([...])`. Give `X` its literal
 *   tuple type.
 * - `(library type)`: a library type named in the union. Make the member
 *   optional without `| undefined`, or let the type be inferred.
 *
 * It checks the whole program rather than one source file, so it has no
 * source file of its own. It runs the TypeScript compiler, hence a `*.test.ts`
 * file, through the compiler API of the `typescript` 6 devDependency; port it
 * if that dependency moves to 7, which has a different API.
 */
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  LIBRARY = "@polyipseity/obsidian-plugin-library",
  // The compiler reports file names with `/` on every platform.
  SCANNED = ["src", "assets"].map(
    (dir) => `${join(ROOT, dir).split(sep).join("/")}/`,
  ),
  PROBE = `${join(ROOT, "tests", "fixtures", "scorecard-types").split(sep).join("/")}/`;

function isLibrary(specifier: string): boolean {
  return specifier === LIBRARY || specifier.startsWith(`${LIBRARY}/`);
}

/** `file` relative to the repository, with `/` on every platform. */
function repoPath(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

interface Scan {
  /** Source files the program checked, relative to the repository. */
  readonly files: readonly string[];
  /** `file:line:column member (kind)` for every union or intersection member
   * that becomes `any`. */
  readonly found: readonly string[];
}

function scan(prefixes: readonly string[] = SCANNED): Scan {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!config) {
    throw new Error("tsconfig.json");
  }
  const host = ts.createCompilerHost(config.options),
    cache = ts.createModuleResolutionCache(
      ROOT,
      (name) => name,
      config.options,
    );
  // The program's own source file knows its module format, so imports resolve
  // as `tsc` resolves them.
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirect,
    options,
    containingSourceFile,
  ) =>
    literals.map((literal) =>
      isLibrary(literal.text)
        ? { resolvedModule: undefined }
        : ts.resolveModuleName(
            literal.text,
            containingFile,
            options,
            host,
            cache,
            redirect,
            ts.getModeForUsageLocation(containingSourceFile, literal, options),
          ),
    );
  const scanned = (file: string): boolean =>
      prefixes.some((dir) => file.startsWith(dir)),
    rootNames = config.fileNames.filter(scanned),
    program = ts.createProgram({ host, options: config.options, rootNames }),
    checker = program.getTypeChecker(),
    found: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (!scanned(source.fileName)) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
        for (const member of node.types) {
          const type = checker.getTypeAtLocation(member);
          if (type.flags & ts.TypeFlags.Any) {
            // An unresolved type is an `error` type; one that keeps its alias
            // is the library type itself, the rest is ours.
            const kind =
                "intrinsicName" in type &&
                type.intrinsicName === "error" &&
                type.aliasSymbol !== undefined
                  ? "library type"
                  : "any",
              { line, character } = source.getLineAndCharacterOfPosition(
                member.getStart(source),
              );
            found.push(
              `${repoPath(source.fileName)}:${String(line + 1)}:${String(character + 1)} ${member.getText(source)} (${kind})`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    files: rootNames.map(repoPath),
    found,
  };
}

describe("types without the vendored library", () => {
  it(
    "no union or intersection member becomes any",
    { timeout: 120_000 },
    () => {
      const { files, found } = scan();
      // An empty scan would pass without checking anything.
      expect(files).toContain("src/main.ts");
      expect(files).toContain("src/settings-data.ts");
      expect(found).toStrictEqual([]);
    },
  );

  // A green scan is worth something only while the scan can still go red: a
  // renamed library or another TypeScript would otherwise leave it passing
  // without hiding anything.
  it(
    "finds each kind of member in a sample that has them",
    { timeout: 120_000 },
    () => {
      const { files, found } = scan([PROBE]);
      expect(files).toStrictEqual(["tests/fixtures/scorecard-types/probe.ts"]);
      expect(found).toStrictEqual([
        "tests/fixtures/scorecard-types/probe.ts:16:22 (typeof INFERRED)[number] (any)",
        "tests/fixtures/scorecard-types/probe.ts:18:21 SemVerString (library type)",
        "tests/fixtures/scorecard-types/probe.ts:20:25 (typeof INFERRED)[number] (any)",
      ]);
    },
  );
});
