// @vitest-environment node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

// Integration test for scripts/draft-release.sh, which the release workflow
// (.github/workflows/release.yml) calls. That workflow only runs on GitHub, so
// the script runs here in a temporary folder with a stub `gh` and a stub `git`
// first on PATH: no network, no real release. The order in which the workflow
// calls the script is part of what the script relies on, so the last suite
// reads the workflow. See AGENTS.md (Releases).

const SCRIPT = path.join(__dirname, "../../scripts/draft-release.sh");
const STUB_BIN = path.join(__dirname, "../fixtures/draft-release/bin");
const WORKFLOW = path.join(__dirname, "../../.github/workflows/release.yml");
const FILES = "main.js manifest.json styles.css";
const CHANGELOG = `# obsidian-terminal

## 3.28.0

### Minor Changes

- 1a2b3c4: Newest change.

## 3.27.2

### Patch Changes

- 5d6e7f8: Older change.
`;
const RETITLE = "gh release edit 3.28.0 --title 3.28.0";
/** A release state of the stub `gh`, and the title edits it makes necessary. */
type Release = readonly [state: string, edits: readonly string[]];
const DRAFTS: readonly Release[] = [
  ["draft-titled", []],
  ["draft-titled-extra", []],
  ["draft-untitled", [RETITLE]],
];
const PUBLISHED: readonly Release[] = [
  ["published-untitled", [RETITLE]],
  ["published-titled", []],
  ["published-other-title", [RETITLE]],
];
/** Answers of `gh release view` that say nothing reliable about the release. */
const UNREADABLE = [
  "http502",
  "http401",
  "silent-fail",
  "not-found-inside",
  "http502-then-not-found",
  "not-found-then-http502",
  "empty-ok",
  "not-json",
  "string-draft",
];

function view(tag: string): string {
  return `gh release view ${tag} --json isDraft,name`;
}

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
  /** Every `gh` call, in order. */
  readonly calls: readonly string[];
  /** What the script wrote to `$GITHUB_OUTPUT`. */
  readonly stepOutput: string;
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
        ["gh.log", "step-output", ...FILES.split(" ")].map(async (file) =>
          fs.writeFile(path.join(work, file), ""),
        ),
      );
    });

    afterEach(async () => {
      await fs.rm(work, { force: true, recursive: true });
    });

    async function run(
      step: string,
      state: string,
      tag = "3.28.0",
      commits: Readonly<Record<string, string>> = {},
    ): Promise<Outcome> {
      const notes = path.join(work, "tmp", "release-notes.md"),
        { status, stdout, stderr } = spawnSync(shell, [SCRIPT, step], {
          cwd: work,
          encoding: "utf8",
          // Nothing of the caller's environment but PATH reaches the script.
          env: {
            GH_LOG: path.join(work, "gh.log"),
            GH_TOKEN: "stub",
            GITHUB_OUTPUT: path.join(work, "step-output"),
            GITHUB_REF_NAME: tag,
            GITHUB_REPOSITORY: "o/r",
            PATH: `${STUB_BIN}${path.delimiter}${process.env["PATH"] ?? ""}`,
            RUNNER_TEMP: path.join(work, "tmp"),
            STUB_STATE: state,
            ...commits,
          },
        }),
        log = await fs.readFile(path.join(work, "gh.log"), "utf8");
      return {
        calls: log
          .split("\n")
          .filter(Boolean)
          .map((call) => call.replaceAll(work, "<work>")),
        notes: existsSync(notes) ? await fs.readFile(notes, "utf8") : "",
        output: stdout + stderr,
        status,
        stepOutput: await fs.readFile(path.join(work, "step-output"), "utf8"),
      };
    }

    it("refuses a call that names no step", async () => {
      const { status, output, calls } = await run("", "none");

      expect(status).toBe(2);
      expect(output).toContain("usage:");
      expect(calls).toEqual([]);
    });

    it.each(
      ["check", "draft"].flatMap((step) =>
        UNREADABLE.map((state) => [step, state]),
      ),
    )(
      "%s stops when the release state cannot be read (%s)",
      async (step, state) => {
        // Tag 9.9.9 has no notes either: the unreadable state is what is reported.
        const { status, output, calls, stepOutput } = await run(
          step,
          state,
          "9.9.9",
        );

        expect(status).toBe(1);
        expect(output).toContain(
          "::error::Release state for tag 9.9.9 could not be read.",
        );
        expect(calls).toEqual([view("9.9.9")]);
        expect(stepOutput).toBe("");
      },
    );

    describe("check, before the build", () => {
      it("passes when there is no release and CHANGELOG.md has notes for the tag", async () => {
        const { status, calls, stepOutput } = await run("check", "none");

        expect(status).toBe(0);
        expect(calls).toEqual([view("3.28.0")]);
        expect(stepOutput).toBe("");
      });

      it("stops when a draft would have to be created without notes", async () => {
        const { status, output, calls } = await run("check", "none", "9.9.9");

        expect(status).toBe(1);
        expect(output).toContain(
          "::error::No CHANGELOG.md notes found for 9.9.9.",
        );
        expect(calls).toEqual([view("9.9.9")]);
      });

      it.each(DRAFTS)(
        "leaves a draft to the draft step (%s)",
        async (state) => {
          const { status, calls, stepOutput } = await run("check", state);

          expect(status).toBe(0);
          expect(calls).toEqual([view("3.28.0")]);
          expect(stepOutput).toBe("");
        },
      );

      it.each(PUBLISHED)(
        "reports a published release and leaves its files alone (%s)",
        async (state, edits) => {
          const { status, output, calls, stepOutput } = await run(
            "check",
            state,
          );

          expect(status).toBe(0);
          expect(output).toContain(
            "::warning::Release 3.28.0 is already published.",
          );
          expect(calls).toEqual([view("3.28.0"), ...edits]);
          expect(stepOutput).toBe("published=true\n");
        },
      );
    });

    describe("tag, before the attestation", () => {
      const BUILT = "8cbff8938df29d1d0c3f1037044e86d936af7e88",
        MOVED = "8e1c0770bae2302cfb8b553cc41143191f04f816",
        LOOKUP = "gh api repos/o/r/commits/refs/tags/3.28.0 --jq .sha";

      it("passes when the tag still points at the checked-out commit", async () => {
        const { status, calls } = await run("tag", "none", "3.28.0", {
          STUB_HEAD: BUILT,
          STUB_TAG_COMMIT: BUILT,
        });

        expect(status).toBe(0);
        expect(calls).toEqual([LOOKUP]);
      });

      it("stops when the tag points at another commit now", async () => {
        const { status, output, calls } = await run("tag", "none", "3.28.0", {
          STUB_HEAD: BUILT,
          STUB_TAG_COMMIT: MOVED,
        });

        expect(status).toBe(1);
        expect(output).toContain(
          `::error::Tag 3.28.0 points at ${MOVED} now; this run built ${BUILT}.`,
        );
        expect(calls).toEqual([LOOKUP]);
      });

      it("stops when the commit of the tag cannot be read", async () => {
        const { status, output } = await run("tag", "none", "3.28.0", {
          STUB_HEAD: BUILT,
        });

        expect(status).toBe(1);
        expect(output).toContain(
          "::error::The commit of tag 3.28.0 could not be read.",
        );
      });
    });

    describe("draft, after the attestation", () => {
      it("creates a draft with the notes of the tag when there is no release", async () => {
        const { status, output, calls, notes } = await run("draft", "none");

        expect(status).toBe(0);
        expect(output).toContain(
          "No release for 3.28.0 yet; creating a draft.",
        );
        expect(calls).toEqual([
          view("3.28.0"),
          `gh release create 3.28.0 ${FILES} --draft --title 3.28.0 --notes-file <work>/tmp/release-notes.md`,
        ]);
        expect(notes).toBe(
          "\n### Minor Changes\n\n- 1a2b3c4: Newest change.\n\n",
        );
      });

      it("creates nothing when CHANGELOG.md has no section for the tag", async () => {
        const { status, output, calls } = await run("draft", "none", "9.9.9");

        expect(status).toBe(1);
        expect(output).toContain(
          "::error::No CHANGELOG.md notes found for 9.9.9.",
        );
        expect(calls).toEqual([view("9.9.9")]);
      });

      it.each(DRAFTS)(
        "replaces the files of a draft (%s)",
        async (state, edits) => {
          const { status, calls } = await run("draft", state);

          expect(status).toBe(0);
          expect(calls).toEqual([
            view("3.28.0"),
            ...edits,
            `gh release upload 3.28.0 ${FILES} --clobber`,
          ]);
        },
      );

      it.each(PUBLISHED)(
        "leaves the files of a release published during the run alone (%s)",
        async (state, edits) => {
          const { status, output, calls } = await run("draft", state);

          expect(status).toBe(0);
          expect(output).toContain(
            "::warning::Published files were left as they are",
          );
          expect(calls).toEqual([view("3.28.0"), ...edits]);
        },
      );
    });
  },
);

const Workflow = v.object({
  jobs: v.object({
    release: v.object({
      if: v.optional(v.string()),
      "timeout-minutes": v.optional(v.number()),
      steps: v.array(
        v.object({
          id: v.optional(v.string()),
          if: v.optional(v.string()),
          run: v.optional(v.string()),
          uses: v.optional(v.string()),
          with: v.optional(v.record(v.string(), v.unknown())),
        }),
      ),
    }),
  }),
});

describe(".github/workflows/release.yml", () => {
  const job = v.parse(Workflow, parse(readFileSync(WORKFLOW, "utf8"))).jobs
      .release,
    { steps } = job;

  function runs(command: string): number {
    return steps.findIndex(({ run }) => run === command);
  }

  it("runs where releases are cut, and elsewhere only when a repository opts in", () => {
    expect(job.if).toBe(
      "github.repository == 'polyipseity/obsidian-terminal' || vars.RELEASE_ON_TAG == 'true'",
    );
  });

  it("ends a hung job after 15 minutes", () => {
    expect(job["timeout-minutes"]).toBe(15);
  });

  it("keeps the checkout's credentials away from the build", () => {
    const checkout = steps.find(({ uses }) =>
      uses?.startsWith("actions/checkout@"),
    );

    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
  });

  it("checks the release before the build and the tag before the attestation, and drafts last", () => {
    const order = [
      runs("bash scripts/draft-release.sh check"),
      runs("bun run build"),
      runs("bash scripts/draft-release.sh tag"),
      steps.findIndex(({ uses }) => uses?.startsWith("actions/attest@")),
      runs("bash scripts/draft-release.sh draft"),
    ];

    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("skips every later step once the check reports a published release", () => {
    const later = steps.slice(steps.findIndex(({ id }) => id === "check") + 1);

    expect(steps[runs("bash scripts/draft-release.sh check")]?.id).toBe(
      "check",
    );
    expect(later.map((step) => step.if)).toEqual(
      later.map(() => "steps.check.outputs.published != 'true'"),
    );
  });
});
