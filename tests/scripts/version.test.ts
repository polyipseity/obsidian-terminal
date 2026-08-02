// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../scripts/utils.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../scripts/utils.mjs")>();
  return { ...actual, execute: vi.fn().mockResolvedValue("") };
});

const ManifestSchema = v.object({
  author: v.optional(v.string()),
  description: v.optional(v.string()),
  version: v.string(),
  fundingUrl: v.optional(v.record(v.string(), v.string())),
});

const ManifestBetaSchema = v.object({
  version: v.string(),
});

const VersionsSchema = v.record(v.string(), v.string());

const RecordSchema = v.record(v.string(), v.unknown());

function expectSortedKeys(raw: string): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const entries = Object.entries(v.parse(RecordSchema, value));
    expect(entries.map(([key]) => key)).toEqual(
      entries.map(([key]) => key).sort(),
    );
    for (const [, entry] of entries) {
      walk(entry);
    }
  };
  walk(JSON.parse(raw));
}

// Integration tests for scripts/version.mjs (mirrors top-level behaviour)
// See AGENTS.md (Testing section) — this is an integration test and uses
// jest-like isolation by resetting modules and providing mocks.

async function writePackageAndVersions(project: string, packageContents = {}) {
  const pkg = {
    author: "Tester",
    description: "A test package",
    version: "0.1.0",
    obsidian: { minAppVersion: "1.0.0" },
    ...packageContents,
  };
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(pkg, null, "  "),
  );
  await fs.writeFile(
    path.join(project, "versions.json"),
    JSON.stringify({}, null, "  "),
  );
  return pkg;
}

describe("scripts/version.mjs", () => {
  it("creates manifest.json, manifest-beta.json and updates versions.json", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "version-proj-"));
    const pkg = await writePackageAndVersions(project, {
      version: "1.2.3",
      funding: [{ type: "paypal", url: "https://paypal.me/test" }],
    });

    vi.resetModules();

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = v.parse(
      ManifestSchema,
      JSON.parse(
        await fs.readFile(path.join(project, "manifest.json"), "utf-8"),
      ),
    );
    expect(manifest.author).toBe(pkg.author);
    expect(manifest.description).toBe(pkg.description);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.fundingUrl).toEqual({ paypal: "https://paypal.me/test" });

    const manifestBeta = v.parse(
      ManifestBetaSchema,
      JSON.parse(
        await fs.readFile(path.join(project, "manifest-beta.json"), "utf-8"),
      ),
    );
    expect(manifestBeta.version).toBe("rolling");

    const versions = v.parse(
      VersionsSchema,
      JSON.parse(
        await fs.readFile(path.join(project, "versions.json"), "utf-8"),
      ),
    );
    expect(versions["1.2.3"]).toBe(pkg.obsidian.minAppVersion);
  });

  it("omits fundingUrl when package.json has no funding field", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "version-proj-"));
    await writePackageAndVersions(project, { version: "2.0.0" });

    vi.resetModules();

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = v.parse(
      ManifestSchema,
      JSON.parse(
        await fs.readFile(path.join(project, "manifest.json"), "utf-8"),
      ),
    );
    expect(manifest.fundingUrl).toBeUndefined();
  });

  it("maps multiple funding entries to fundingUrl object", async () => {
    const project = await fs.mkdtemp(
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
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify(pkg, null, "  "),
    );
    await fs.writeFile(
      path.join(project, "versions.json"),
      JSON.stringify({}, null, "  "),
    );

    vi.resetModules();

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = v.parse(
      ManifestSchema,
      JSON.parse(
        await fs.readFile(path.join(project, "manifest.json"), "utf-8"),
      ),
    );
    expect(manifest.fundingUrl).toEqual({
      paypal: "https://paypal.me/x",
      github: "https://github.com/sponsor",
    });
  });

  it("merges `obsidian` fields into manifest and allows override", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "version-obs-proj-"),
    );
    const pkg = {
      author: "Author A",
      description: "Original description",
      version: "4.0.0",
      obsidian: {
        description: "Obsidianny description",
        minAppVersion: "9.9.9",
      },
    };
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify(pkg, null, "  "),
    );
    await fs.writeFile(
      path.join(project, "versions.json"),
      JSON.stringify({}, null, "  "),
    );

    vi.resetModules();

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const manifest = v.parse(
      ManifestSchema,
      JSON.parse(
        await fs.readFile(path.join(project, "manifest.json"), "utf-8"),
      ),
    );
    expect(manifest.description).toBe("Obsidianny description");
    expect(manifest.version).toBe(pkg.version);
  });

  it("writes alphabetically sorted manifest keys", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "version-sort-proj-"),
    );
    await writePackageAndVersions(project, {
      version: "1.2.3",
      funding: [
        { type: "paypal", url: "https://paypal.me/x" },
        { type: "github", url: "https://github.com/sponsor" },
      ],
    });

    vi.resetModules();

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const raw = await fs.readFile(path.join(project, "manifest.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expectSortedKeys(raw);
    expect(v.parse(ManifestSchema, JSON.parse(raw)).fundingUrl).toEqual({
      github: "https://github.com/sponsor",
      paypal: "https://paypal.me/x",
    });
  });

  it("writes sorted manifest-beta with rolling version", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "version-beta-sort-proj-"),
    );
    await writePackageAndVersions(project, { version: "2.0.0" });

    vi.resetModules();

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const raw = await fs.readFile(
      path.join(project, "manifest-beta.json"),
      "utf-8",
    );
    expect(raw.endsWith("\n")).toBe(true);
    expectSortedKeys(raw);
    expect(v.parse(ManifestBetaSchema, JSON.parse(raw)).version).toBe(
      "rolling",
    );
  });

  it("writes versions.json keys in prettier sort order", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "version-vers-sort-proj-"),
    );
    await writePackageAndVersions(project, { version: "1.9.0" });
    await fs.writeFile(
      path.join(project, "versions.json"),
      JSON.stringify({ "1.10.0": "1.2.0", "1.2.3": "1.0.0" }, null, "  "),
    );

    vi.resetModules();

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version.mjs");
    } finally {
      process.chdir(cwd);
    }

    const raw = await fs.readFile(path.join(project, "versions.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(Object.keys(v.parse(VersionsSchema, JSON.parse(raw)))).toEqual([
      "1.10.0",
      "1.2.3",
      "1.9.0",
    ]);
  });
});
