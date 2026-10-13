/**
 * Integration tests for `src/terminal/dropped-paths.ts`: the texts it writes
 * for a shell of the sh family are handed to the real shells of this machine,
 * which give back the arguments they read.
 *
 * `dropped-paths.spec.ts` checks the same texts against readers that model
 * each shell. A model can be wrong along with the writer; a shell cannot.
 *
 * The shells read the text as a command, not at a prompt, so what only an
 * interactive shell does is not covered here: history expansion of `!`, and
 * the line editor. Nothing is read from or written to the disk: the paths
 * need not exist, and the few that could match a file do so in `/bin`.
 *
 * Not run on Windows, which has no shell of this family at a known path.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ShellGrammar,
  formatDroppedPaths,
} from "../../../src/terminal/dropped-paths.js";

/** A shell, where it may be installed, and how it is started without its startup files. */
interface Shell {
  readonly name: string;
  readonly candidates: readonly string[];
  readonly options: readonly string[];
}

const SHELLS: readonly Shell[] = [
    { candidates: ["/bin/sh"], name: "sh", options: [] },
    {
      candidates: ["/bin/bash", "/usr/bin/bash"],
      name: "bash",
      options: ["--noprofile", "--norc"],
    },
    { candidates: ["/bin/zsh", "/usr/bin/zsh"], name: "zsh", options: ["-f"] },
    { candidates: ["/bin/dash", "/usr/bin/dash"], name: "dash", options: [] },
  ],
  // Every printable character of ASCII, the space and the backslash included.
  ASCII = Array.from({ length: 0x7f - 0x20 }, (_value, index) =>
    String.fromCharCode(0x20 + index),
  ),
  // Each of them at the start, in the middle and at the end of a name: some
  // are special only in one place, as `~` and `#` are at the start of a word.
  NAMES: readonly string[] = [
    ...ASCII.flatMap((character) => [
      `${character}start`,
      `mid${character}dle`,
      `end${character}`,
    ]),
    "two  spaces",
    " space at the start",
    "it's a (test) & more.md",
    'double "quote" and $HOME and `echo tick`.md',
    "$(echo substituted).png",
    "semi;colon #hash !bang.md",
    "100% [brackets] {a,b} ^caret.png",
    "ünïcødé 日本語 😀.png",
    "star* question? pipe| lt< gt>.md",
    "back\\slash and a trailing one\\",
    "'",
    '"',
    "''",
    "-n",
  ],
  // Names under `/bin` that a shell would replace by `/bin/sh` if it took
  // them for a pattern: a pattern that matches nothing stays as it is in
  // most shells, and would pass for a name that was read literally.
  PATTERNS: readonly string[] = ["s?", "?h", "[s]h", "s*", "{sh,sh}"],
  POSIX_DIRECTORY = "/Users/me/My Vault/",
  WIN32_DIRECTORY = "C:\\Users\\me\\My Vault\\",
  LINUX_DIRECTORY = "/mnt/c/Users/me/My Vault/";

/**
 * The paths to write for a grammar, each with the path the shell must read.
 * Under WSL a Windows path is read as its Linux path, and a backslash is a
 * separator there, not a character of a name.
 */
function cases(
  grammar: ShellGrammar,
): readonly (readonly [written: string, read: string])[] {
  switch (grammar) {
    case "posix":
      return [
        ...NAMES.map((name) => POSIX_DIRECTORY + name),
        ...PATTERNS.map((name) => `/bin/${name}`),
      ].map((path) => [path, path]);
    case "posix-quoted":
      return [
        ...NAMES.map((name) => WIN32_DIRECTORY + name),
        ...PATTERNS.map((name) => `/bin/${name}`),
      ].map((path) => [path, path]);
    case "wsl":
      return [
        ...NAMES.filter((name) => !name.includes("\\")).map(
          (name): readonly [string, string] => [
            WIN32_DIRECTORY + name,
            LINUX_DIRECTORY + name,
          ],
        ),
        ...PATTERNS.map((name): readonly [string, string] => [
          `/bin/${name}`,
          `/bin/${name}`,
        ]),
      ];
    default:
      throw new Error(`${grammar} is not read by a shell of the sh family`);
  }
}

/** The arguments a shell reads in a text, which it prints with a NUL after each. */
function argumentsRead(
  executable: string,
  options: readonly string[],
  text: string,
): readonly string[] {
  const printed = execFileSync(
    executable,
    [...options, "-c", `printf '%s\\0' ${text}`],
    {
      cwd: "/",
      // Nothing of the environment of the test run reaches the shell.
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10_000,
    },
  )
    .toString("utf8")
    .split("\0");
  // The NUL after the last argument leaves an empty string behind it.
  return printed.slice(0, -1);
}

describe.skipIf(process.platform === "win32")(
  "dropped paths read by the shells of this machine",
  () => {
    describe.each(
      SHELLS.map((shell): readonly [string, Shell] => [shell.name, shell]),
    )("%s", (_name, { candidates, options }) => {
      const executable = candidates.find((candidate) => existsSync(candidate));

      it
        .skipIf(executable === undefined)
        .each<ShellGrammar>(["posix", "posix-quoted", "wsl"])(
        "reads each path written for %s as one argument",
        (grammar) => {
          if (executable === undefined) {
            throw new Error("skipped without the shell");
          }
          const paths = cases(grammar),
            { skipped, texts } = formatDroppedPaths(
              paths.map(([written]) => written),
              grammar,
            );

          expect(skipped).toBe(0);
          // As they are pasted: one after the other, a space after each.
          expect(argumentsRead(executable, options, texts.join(""))).toEqual(
            paths.map(([, read]) => read),
          );
        },
      );
    });

    // Without this the tests above could pass on a machine that has none.
    it("finds the shell that every such machine has", () => {
      expect(existsSync("/bin/sh")).toBe(true);
    });
  },
);
