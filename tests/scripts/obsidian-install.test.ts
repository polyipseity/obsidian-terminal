// @vitest-environment node

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const execFile = promisify(execFileCb);

// Integration test for scripts/obsidian-install.mjs
// See AGENTS.md (Testing section) — this is an integration test and
// mirrors the behavior of the runtime script using temporary dirs.

async function setupProject(tmp: string): Promise<void> {
  await fs.writeFile(
    path.join(tmp, "manifest.json"),
    JSON.stringify({ id: "copy-test" }),
  );
  await fs.writeFile(path.join(tmp, "main.js"), "console.log('main');\n");
  await fs.writeFile(path.join(tmp, "styles.css"), "/* styles */\n");
}

describe("scripts/obsidian-install.mjs", () => {
  it("copies manifest, main and styles to provided destination", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "obsidian-install-proj-"),
    );
    const dest = await fs.mkdtemp(
      path.join(os.tmpdir(), "obsidian-install-dest-"),
    );
    await setupProject(project);

    await execFile(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), dest],
      { cwd: project },
    );

    const expectedDir = path.join(dest, ".obsidian", "plugins", "copy-test");
    expect(
      await fs
        .access(path.join(expectedDir, "manifest.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await fs.readFile(path.join(expectedDir, "main.js"), "utf-8"),
    ).toContain("console.log('main')");
    expect(
      await fs
        .access(path.join(expectedDir, "styles.css"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("defaults to current directory when no destination arg is passed", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "obsidian-install-proj-"),
    );
    await setupProject(project);

    await execFile(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs")],
      { cwd: project },
    );

    const expectedDir = path.join(project, ".obsidian", "plugins", "copy-test");
    expect(
      await fs
        .access(path.join(expectedDir, "manifest.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await fs.readFile(path.join(expectedDir, "main.js"), "utf-8"),
    ).toContain("console.log('main')");
    expect(
      await fs
        .access(path.join(expectedDir, "styles.css"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("fails gracefully when manifest.json is missing", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "obsidian-install-edge-"),
    );
    await fs.writeFile(path.join(project, "main.js"), "console.log('x')\n");
    await fs.writeFile(path.join(project, "styles.css"), "/* x */\n");

    // Use execFile and catch its rejection to inspect status and stderr
    try {
      await execFile(
        process.execPath,
        [path.join(__dirname, "../../scripts/obsidian-install.mjs")],
        { cwd: project },
      );
      expect.fail("Expected execFile to reject");
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; code?: number };
      expect(execErr.code).not.toBe(0);
      expect(execErr.stderr).toContain("Error reading manifest.json:");
    }
  });

  it("copies into existing destination directory without error", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "obsidian-install-proj-"),
    );
    const dest = await fs.mkdtemp(
      path.join(os.tmpdir(), "obsidian-install-dest-"),
    );

    await fs.writeFile(
      path.join(project, "manifest.json"),
      JSON.stringify({ id: "edge-copy" }),
    );
    await fs.writeFile(path.join(project, "main.js"), "console.log('main');\n");
    await fs.writeFile(path.join(project, "styles.css"), "/* styles */\n");

    await fs.mkdir(path.join(dest, ".obsidian"), { recursive: true });
    await fs.mkdir(path.join(dest, ".obsidian", "plugins"), {
      recursive: true,
    });

    await execFile(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), dest],
      { cwd: project },
    );

    const expectedDir = path.join(dest, ".obsidian", "plugins", "edge-copy");
    expect(
      await fs
        .access(path.join(expectedDir, "manifest.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await fs
        .access(path.join(expectedDir, "main.js"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("accepts destination with trailing slash and copies correctly", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "obs-install-proj-"),
    );
    const dest =
      (await fs.mkdtemp(path.join(os.tmpdir(), "obs-install-dest-"))) +
      path.sep;

    await fs.writeFile(
      path.join(project, "manifest.json"),
      JSON.stringify({ id: "trail-test" }),
    );
    await fs.writeFile(path.join(project, "main.js"), "console.log('m');\n");
    await fs.writeFile(path.join(project, "styles.css"), "/* s */\n");

    await execFile(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), dest],
      { cwd: project },
    );

    const expectedDir = path.join(dest, ".obsidian", "plugins", "trail-test");
    expect(
      await fs
        .access(path.join(expectedDir, "manifest.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("accepts '.' as destination and copies into ./ .obsidian/plugins/<id>", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "obs-install-proj-"),
    );

    await fs.writeFile(
      path.join(project, "manifest.json"),
      JSON.stringify({ id: "dot-dest" }),
    );
    await fs.writeFile(path.join(project, "main.js"), "console.log('m');\n");
    await fs.writeFile(path.join(project, "styles.css"), "/* s */\n");

    await execFile(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), "."],
      { cwd: project },
    );

    const expectedDir = path.join(project, ".obsidian", "plugins", "dot-dest");
    expect(
      await fs
        .access(path.join(expectedDir, "manifest.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  }, 20000);
});
