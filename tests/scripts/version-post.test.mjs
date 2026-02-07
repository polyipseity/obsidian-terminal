import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration tests for scripts/version-post.mjs — verifies trimming and
// git interactions via a mocked `execute` in util.

describe("scripts/version-post.mjs", () => {
  let cwd;
  beforeEach(() => {
    cwd = process.cwd();
    vi.resetModules();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.chdir(cwd);
  });

  it("trims trailing whitespace on package files and runs git commands with tag message", async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "version-post-proj-"),
    );
    fs.writeFileSync(
      path.join(project, "package.json"),
      '{\n  "name": "x"\n}  \n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(project, "package-lock.json"),
      '{\n  "lock": true\n}\n\n  ',
      "utf-8",
    );

    const calls = [];
    vi.doMock("../../scripts/util.mjs", () => ({
      PATHS: {
        package: "package.json",
        packageLock: "package-lock.json",
      },
      execute: vi.fn((cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "git" && args[0] === "tag" && args[1] === "--points-at") {
          return Promise.resolve("v0.1.0\n");
        }
        if (cmd === "git" && args[0] === "tag" && args[1] === "--list") {
          return Promise.resolve("Release subject\nRelease body\n");
        }
        return Promise.resolve("");
      }),
    }));

    process.chdir(project);
    await import("../../scripts/version-post.mjs");

    const p = fs.readFileSync(path.join(project, "package.json"), "utf-8");
    const pl = fs.readFileSync(
      path.join(project, "package-lock.json"),
      "utf-8",
    );
    expect(/\s$/.test(p)).toBe(false);
    expect(/\s$/.test(pl)).toBe(false);
    expect(p.endsWith("  \n")).toBe(false);
    expect(pl.endsWith("  \n")).toBe(false);

    expect(
      calls.some(
        (c) =>
          c.cmd === "git" &&
          c.args[0] === "add" &&
          c.args.includes("package.json") &&
          c.args.includes("package-lock.json"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.cmd === "git" &&
          c.args.includes("--amend") &&
          c.args.includes("--no-edit"),
      ),
    ).toBe(true);

    const tagCall = calls.find(
      (c) =>
        c.cmd === "git" &&
        c.args.includes("--sign") &&
        c.args.includes("--force"),
    );
    expect(tagCall).toBeDefined();
    const messageArg = tagCall.args.find((a) => a.startsWith("--message="));
    expect(messageArg).toContain("Release subject");
    expect(messageArg).toContain("Release body");
  });

  it("still runs add/commit even when tag message has only a single line", async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "version-post-proj-"),
    );
    fs.writeFileSync(
      path.join(project, "package.json"),
      '{"x": 1}\n\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(project, "package-lock.json"),
      '{"lock": true}\n',
      "utf-8",
    );

    const calls = [];
    vi.doMock("../../scripts/util.mjs", () => ({
      PATHS: {
        package: "package.json",
        packageLock: "package-lock.json",
      },
      execute: vi.fn((cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "git" && args[0] === "tag" && args[1] === "--points-at") {
          return Promise.resolve("v0.2.0\n");
        }
        if (cmd === "git" && args[0] === "tag" && args[1] === "--list") {
          return Promise.resolve("Single-line subject\n");
        }
        return Promise.resolve("");
      }),
    }));

    process.chdir(project);
    await import("../../scripts/version-post.mjs");

    expect(calls.some((c) => c.cmd === "git" && c.args[0] === "add")).toBe(
      true,
    );
    expect(
      calls.some((c) => c.cmd === "git" && c.args.includes("--amend")),
    ).toBe(true);
  });

  it("still runs add and commit even if tag string is empty", async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "version-post-emptytag-"),
    );
    fs.writeFileSync(
      path.join(project, "package.json"),
      '{"name":"x"}\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(project, "package-lock.json"),
      '{"lock":true}\n',
      "utf-8",
    );

    const calls = [];
    vi.doMock("../../scripts/util.mjs", () => ({
      PATHS: {
        package: "package.json",
        packageLock: "package-lock.json",
      },
      execute: vi.fn((cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "git" && args[0] === "tag" && args[1] === "--points-at") {
          return Promise.resolve("\n");
        }
        if (cmd === "git" && args[0] === "tag" && args[1] === "--list") {
          return Promise.resolve("\n");
        }
        return Promise.resolve("");
      }),
    }));

    const cwd = process.cwd();
    try {
      process.chdir(project);
      await import("../../scripts/version-post.mjs");
    } finally {
      process.chdir(cwd);
    }

    expect(calls.some((c) => c.cmd === "git" && c.args[0] === "add")).toBe(
      true,
    );
    expect(
      calls.some((c) => c.cmd === "git" && c.args.includes("--amend")),
    ).toBe(true);
    expect(
      calls.some((c) => c.cmd === "git" && c.args.includes("--sign")),
    ).toBe(true);
  });
});
