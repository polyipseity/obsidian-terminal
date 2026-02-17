// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

// Integration test for scripts/obsidian-install.mjs
// See AGENTS.md (Testing section) — this is an integration test and
// mirrors the behavior of the runtime script using temporary dirs.

function setupProject(tmp) {
  fs.writeFileSync(
    path.join(tmp, "manifest.json"),
    JSON.stringify({ id: "copy-test" }),
  );
  fs.writeFileSync(path.join(tmp, "main.js"), "console.log('main');\n");
  fs.writeFileSync(path.join(tmp, "styles.css"), "/* styles */\n");
}

describe("scripts/obsidian-install.mjs", () => {
  it("copies manifest, main and styles to provided destination", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "obsidian-install-proj-"),
    );
    const dest = fs.mkdtempSync(
      path.join(os.tmpdir(), "obsidian-install-dest-"),
    );
    setupProject(project);

    execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), dest],
      { cwd: project },
    );

    const expectedDir = path.join(dest, ".obsidian", "plugins", "copy-test");
    expect(fs.existsSync(path.join(expectedDir, "manifest.json"))).toBe(true);
    expect(
      fs.readFileSync(path.join(expectedDir, "main.js"), "utf-8"),
    ).toContain("console.log('main')");
    expect(fs.existsSync(path.join(expectedDir, "styles.css"))).toBe(true);
  });

  it("defaults to current directory when no destination arg is passed", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "obsidian-install-proj-"),
    );
    setupProject(project);

    execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs")],
      { cwd: project },
    );

    const expectedDir = path.join(project, ".obsidian", "plugins", "copy-test");
    expect(fs.existsSync(path.join(expectedDir, "manifest.json"))).toBe(true);
    expect(
      fs.readFileSync(path.join(expectedDir, "main.js"), "utf-8"),
    ).toContain("console.log('main')");
    expect(fs.existsSync(path.join(expectedDir, "styles.css"))).toBe(true);
  });

  it("fails gracefully when manifest.json is missing", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "obsidian-install-edge-"),
    );
    fs.writeFileSync(path.join(project, "main.js"), "console.log('x')\n");
    fs.writeFileSync(path.join(project, "styles.css"), "/* x */\n");

    // Use spawnSync so we can inspect status and stderr without throwing
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs")],
      {
        cwd: project,
        encoding: "utf-8",
      },
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Error reading manifest.json:");
  });

  it("copies into existing destination directory without error", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "obsidian-install-proj-"),
    );
    const dest = fs.mkdtempSync(
      path.join(os.tmpdir(), "obsidian-install-dest-"),
    );

    fs.writeFileSync(
      path.join(project, "manifest.json"),
      JSON.stringify({ id: "edge-copy" }),
    );
    fs.writeFileSync(path.join(project, "main.js"), "console.log('main');\n");
    fs.writeFileSync(path.join(project, "styles.css"), "/* styles */\n");

    fs.mkdirSync(path.join(dest, ".obsidian"), { recursive: true });
    fs.mkdirSync(path.join(dest, ".obsidian", "plugins"), { recursive: true });

    execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), dest],
      { cwd: project },
    );

    const expectedDir = path.join(dest, ".obsidian", "plugins", "edge-copy");
    expect(fs.existsSync(path.join(expectedDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, "main.js"))).toBe(true);
  });

  it("accepts destination with trailing slash and copies correctly", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "obs-install-proj-"));
    const dest =
      fs.mkdtempSync(path.join(os.tmpdir(), "obs-install-dest-")) + path.sep;

    fs.writeFileSync(
      path.join(project, "manifest.json"),
      JSON.stringify({ id: "trail-test" }),
    );
    fs.writeFileSync(path.join(project, "main.js"), "console.log('m');\n");
    fs.writeFileSync(path.join(project, "styles.css"), "/* s */\n");

    execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), dest],
      { cwd: project },
    );

    const expectedDir = path.join(dest, ".obsidian", "plugins", "trail-test");
    expect(fs.existsSync(path.join(expectedDir, "manifest.json"))).toBe(true);
  });

  it("accepts '.' as destination and copies into ./ .obsidian/plugins/<id>", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "obs-install-proj-"));

    fs.writeFileSync(
      path.join(project, "manifest.json"),
      JSON.stringify({ id: "dot-dest" }),
    );
    fs.writeFileSync(path.join(project, "main.js"), "console.log('m');\n");
    fs.writeFileSync(path.join(project, "styles.css"), "/* s */\n");

    execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/obsidian-install.mjs"), "."],
      { cwd: project },
    );

    const expectedDir = path.join(project, ".obsidian", "plugins", "dot-dest");
    expect(fs.existsSync(path.join(expectedDir, "manifest.json"))).toBe(true);
  }, 20000);
});
