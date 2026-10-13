// @vitest-environment node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Integration test for scripts/draft-release.sh, which the release workflow
// (.github/workflows/release.yml) calls. That workflow only runs on GitHub, so
// the script runs here in a temporary folder with a stub `gh` first on PATH:
// no network, no real release. See AGENTS.md (Testing section).

const SCRIPT = path.join(__dirname, "../../scripts/draft-release.sh");
const STUB_BIN = path.join(__dirname, "../fixtures/draft-release/bin");
const FILES = "main.js manifest.json styles.css";
const CHANGELOG = `# obsidian-terminal

## 3.28.0

### Minor Changes

- 1a2b3c4: Newest change.

## 3.27.2

### Patch Changes

- 5d6e7f8: Older change.
`;

// macOS ships bash 3.2 as /bin/bash and the release runner has bash 5. Run the
// script under every bash this machine has, so both are covered where both exist.
const found = [
  ...new Set(
    ["/bin", ...(process.env["PATH"] ?? "").split(path.delimiter)]
      .map((dir) => path.join(dir, "bash"))
      .filter((file) => existsSync(file))
      .map((file) => realpathSync(file)),
  ),
];
const SHELLS: readonly string[] = found.length > 0 ? found : ["bash"];

interface Outcome {
  readonly status: number | null;
  /** Standard output followed by standard error. */
  readonly output: string;
  /** The `gh` calls after the first one, which always reads the release. */
  readonly calls: readonly string[];
  readonly notes: string;
}

// The script is bash and needs jq and awk next to it. Windows has none of them
// by default and the release runner is Linux, so the suite does not run there.
describe.skipIf(process.platform === "win32").each(SHELLS)(
  "scripts/draft-release.sh under %s",
  (shell) => {
    let work: string;

    beforeEach(async () => {
      work = await fs.mkdtemp(path.join(os.tmpdir(), "draft-release-"));
      await fs.mkdir(path.join(work, "tmp"));
      await fs.writeFile(path.join(work, "CHANGELOG.md"), CHANGELOG);
      await Promise.all(
        FILES.split(" ").map(async (file) =>
          fs.writeFile(path.join(work, file), ""),
        ),
      );
    });

    afterEach(async () => {
      await fs.rm(work, { force: true, recursive: true });
    });

    async function run(state: string, tag: string): Promise<Outcome> {
      const log = path.join(work, "gh.log"),
        notes = path.join(work, "tmp", "release-notes.md"),
        { status, stdout, stderr } = spawnSync(shell, [SCRIPT], {
          cwd: work,
          encoding: "utf8",
          // Nothing of the caller's environment but PATH reaches the script.
          env: {
            GH_LOG: log,
            GH_TOKEN: "stub",
            GITHUB_REF_NAME: tag,
            PATH: `${STUB_BIN}${path.delimiter}${process.env["PATH"] ?? ""}`,
            RUNNER_TEMP: path.join(work, "tmp"),
            STUB_STATE: state,
          },
        }),
        calls = (await fs.readFile(log, "utf8"))
          .trimEnd()
          .split("\n")
          .map((call) => call.replaceAll(work, "<work>"));
      expect(calls[0]).toBe(`gh release view ${tag} --json isDraft,name`);
      return {
        calls: calls.slice(1),
        notes: existsSync(notes) ? await fs.readFile(notes, "utf8") : "",
        output: stdout + stderr,
        status,
      };
    }

    it("creates a draft with the notes of the tag when there is no release", async () => {
      const { status, output, calls, notes } = await run("none", "3.28.0");

      expect(status).toBe(0);
      expect(output).toContain("No release for 3.28.0 yet; creating a draft.");
      expect(calls).toEqual([
        `gh release create 3.28.0 ${FILES} --draft --title 3.28.0 --notes-file <work>/tmp/release-notes.md`,
      ]);
      expect(notes).toBe(
        "\n### Minor Changes\n\n- 1a2b3c4: Newest change.\n\n",
      );
    });

    it("creates nothing when CHANGELOG.md has no section for the tag", async () => {
      const { status, output, calls } = await run("none", "9.9.9");

      expect(status).toBe(1);
      expect(output).toContain(
        "::error::No CHANGELOG.md notes found for 9.9.9.",
      );
      expect(calls).toEqual([]);
    });

    it.each([
      ["draft-titled", []],
      ["draft-titled-extra", []],
      ["draft-untitled", ["gh release edit 3.28.0 --title 3.28.0"]],
    ])("replaces the files of a draft (%s)", async (state, edits) => {
      const { status, calls } = await run(state, "3.28.0");

      expect(status).toBe(0);
      expect(calls).toEqual([
        ...edits,
        `gh release upload 3.28.0 ${FILES} --clobber`,
      ]);
    });

    it.each([
      ["published-untitled", ["gh release edit 3.28.0 --title 3.28.0"]],
      ["published-titled", []],
      ["published-other-title", ["gh release edit 3.28.0 --title 3.28.0"]],
    ])(
      "leaves the files of a published release alone (%s)",
      async (state, edits) => {
        const { status, output, calls } = await run(state, "3.28.0");

        expect(status).toBe(0);
        expect(output).toContain(
          "::warning::Published files were left as they are",
        );
        expect(calls).toEqual(edits);
      },
    );

    it.each([
      ["http502", "3.28.0"],
      ["http502", "9.9.9"],
      ["http401", "3.28.0"],
      ["silent-fail", "3.28.0"],
      ["not-found-inside", "3.28.0"],
      ["empty-ok", "3.28.0"],
      ["not-json", "3.28.0"],
      ["string-draft", "3.28.0"],
    ])(
      "stops when the release state cannot be read (%s, tag %s)",
      async (state, tag) => {
        const { status, output, calls } = await run(state, tag);

        expect(status).toBe(1);
        expect(output).toContain(
          `::error::Release state for tag ${tag} could not be read.`,
        );
        expect(calls).toEqual([]);
      },
    );
  },
);
