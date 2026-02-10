import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";

// Integration tests for scripts/version.mjs (mirrors top-level behaviour)
// See AGENTS.md (Testing section) — this is an integration test and uses
// jest-like isolation by resetting modules and providing mocks.

function writePackageAndVersions(project, packageContents = {}) {
  const pkg = {
    author: "Tester",
    description: "A test package",
    version: "0.1.0",
    obsidian: { minAppVersion: "1.0.0" },
    ...packageContents,
  };
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify(pkg, null, "\t"),
  );
  fs.writeFileSync(
    path.join(project, "versions.json"),
    JSON.stringify({}, null, "\t"),
  );
  return pkg;
}

describe("scripts/version.mjs", () => {
  it("creates manifest.json, manifest-beta.json and updates versions.json", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "version-proj-"));
    const pkg = writePackageAndVersions(project, {
      version: "1.2.3",
      funding: [{ type: "paypal", url: "https://paypal.me/test" }],
    });

    vi.resetModules();
    vi.mock("../../scripts/utils.mjs", () => ({
      PATHS: {
        main: "./main.js",
        manifest: "manifest.json",
        manifestBeta: "manifest-beta.json",
        metafile: "metafile.json",
        obsidianPlugins: ".obsidian/plugins",
        outDir: ".",
        package: "package.json",
        packageLock: "package-lock.json",
        styles: "styles.css",
        versions: "versions.json",
      },
      execute: vi.fn().mockResolvedValue(""),
    }));

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(project, "manifest.json"), "utf-8"),
    );
    expect(manifest.author).toBe(pkg.author);
    expect(manifest.description).toBe(pkg.description);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.fundingUrl).toEqual({ paypal: "https://paypal.me/test" });

    const manifestBeta = JSON.parse(
      fs.readFileSync(path.join(project, "manifest-beta.json"), "utf-8"),
    );
    expect(manifestBeta.version).toBe("rolling");

    const versions = JSON.parse(
      fs.readFileSync(path.join(project, "versions.json"), "utf-8"),
    );
    expect(versions["1.2.3"]).toBe(pkg.obsidian.minAppVersion);
  });

  it("omits fundingUrl when package.json has no funding field", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "version-proj-"));
    writePackageAndVersions(project, { version: "2.0.0" });

    vi.resetModules();
    vi.mock("../../scripts/utils.mjs", () => ({
      PATHS: {
        main: "./main.js",
        manifest: "manifest.json",
        manifestBeta: "manifest-beta.json",
        metafile: "metafile.json",
        obsidianPlugins: ".obsidian/plugins",
        outDir: ".",
        package: "package.json",
        packageLock: "package-lock.json",
        styles: "styles.css",
        versions: "versions.json",
      },
      execute: vi.fn().mockResolvedValue(""),
    }));

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(project, "manifest.json"), "utf-8"),
    );
    expect(manifest.fundingUrl).toBeUndefined();
  });

  it("maps multiple funding entries to fundingUrl object", async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "version-fund-proj-"),
    );
    const pkg = {
      author: "Funder",
      description: "Funding test",
      version: "3.0.0",
      obsidian: { minAppVersion: "2.0.0" },
      funding: [
        { type: "paypal", url: "https://paypal.me/x" },
        { type: "github", url: "https://github.com/sponsor" },
      ],
    };
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify(pkg, null, "\t"),
    );
    fs.writeFileSync(
      path.join(project, "versions.json"),
      JSON.stringify({}, null, "\t"),
    );

    vi.resetModules();
    vi.mock("../../scripts/utils.mjs", () => ({
      PATHS: {
        main: "./main.js",
        manifest: "manifest.json",
        manifestBeta: "manifest-beta.json",
        metafile: "metafile.json",
        obsidianPlugins: ".obsidian/plugins",
        outDir: ".",
        package: "package.json",
        packageLock: "package-lock.json",
        styles: "styles.css",
        versions: "versions.json",
      },
      execute: vi.fn().mockResolvedValue(""),
    }));

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(project, "manifest.json"), "utf-8"),
    );
    expect(manifest.fundingUrl).toEqual({
      paypal: "https://paypal.me/x",
      github: "https://github.com/sponsor",
    });
  });

  it("merges `obsidian` fields into manifest and allows override", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "version-obs-proj-"));
    const pkg = {
      author: "Author A",
      description: "Original description",
      version: "4.0.0",
      obsidian: {
        description: "Obsidianny description",
        minAppVersion: "9.9.9",
      },
    };
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify(pkg, null, "\t"),
    );
    fs.writeFileSync(
      path.join(project, "versions.json"),
      JSON.stringify({}, null, "\t"),
    );

    vi.resetModules();
    vi.mock("../../scripts/utils.mjs", () => ({
      PATHS: {
        main: "./main.js",
        manifest: "manifest.json",
        manifestBeta: "manifest-beta.json",
        metafile: "metafile.json",
        obsidianPlugins: ".obsidian/plugins",
        outDir: ".",
        package: "package.json",
        packageLock: "package-lock.json",
        styles: "styles.css",
        versions: "versions.json",
      },
      execute: vi.fn().mockResolvedValue(""),
    }));

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(project, "manifest.json"), "utf-8"),
    );
    expect(manifest.description).toBe("Obsidianny description");
    expect(manifest.version).toBe(pkg.version);
  });
});
