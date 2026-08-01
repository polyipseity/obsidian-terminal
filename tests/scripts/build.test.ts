// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration tests for scripts/build.mjs — uses mocked esbuild
// to verify top-level behaviour such as writing a metafile and
// calling watch in dev mode.

function createSpawnMock() {
  return vi.fn().mockImplementation(() => {
    const obj = {
      once(event: string, cb: (code: number, signal: null) => void) {
        if (event === "exit")
          setImmediate(() => {
            cb(0, null);
          });
        return obj;
      },
    };
    return obj;
  });
}

/** Set up identity file (manifest.json) and mock tsc invocations. */
async function setupProject(project: string): Promise<void> {
  await fs.writeFile(
    path.join(project, "manifest.json"),
    JSON.stringify({ id: "test-plugin" }),
  );
  vi.doMock("which", () => ({
    __esModule: true,
    default: vi.fn().mockResolvedValue("bunx"),
  }));
  vi.doMock("node:child_process", () => ({
    execFile: vi.fn(),
    spawn: createSpawnMock(),
  }));
}

describe("scripts/build.mjs", () => {
  let cwd: string;
  beforeEach(() => {
    vi.resetModules();
    cwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(cwd);
    process.argv.splice(2, 1);
    vi.restoreAllMocks();
  });

  it("writes metafile and logs errors when rebuild returns errors and metafile", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "build-proj-"));

    const fakeMetafile = { inputs: { "a.js": {} } };
    const fakeError = { text: "err" };
    const rebuildMock = vi.fn().mockResolvedValue({
      errors: [fakeError],
      warnings: [],
      metafile: fakeMetafile,
    });
    const disposeMock = vi.fn();
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn().mockResolvedValue("ANALYSIS"),
      formatMessages: vi.fn().mockResolvedValue(["formatted error"]),
      context: vi.fn().mockResolvedValue({
        rebuild: rebuildMock,
        dispose: disposeMock,
      }),
    }));

    await setupProject(project);

    const cwd = process.cwd();
    process.chdir(project);

    // Spy on console to prevent noisy test output and assert logged messages
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await import("../../scripts/build.mjs");
    } finally {
      process.chdir(cwd);
    }

    const esbuild = vi.mocked(await import("esbuild"));

    expect(rebuildMock).toHaveBeenCalled();
    expect(disposeMock).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.anything() satisfies unknown as unknown,
      }),
      expect.anything(),
    );
    expect(esbuild.formatMessages).toHaveBeenCalled();

    // verify the module logged analyzeMetafile output and formatted errors
    expect(logSpy).toHaveBeenCalledWith("ANALYSIS");
    expect(errSpy).toHaveBeenCalledWith("formatted error");

    const mf = v.parse(
      v.pipe(v.string(), v.parseJson()),
      await fs.readFile(path.join(project, "metafile.json"), "utf-8"),
    );
    expect(mf).toEqual(fakeMetafile);
  });

  it("calls watch when argv contains 'dev'", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "build-proj-"));
    process.chdir(project);

    await setupProject(project);

    const watch = vi.fn();
    const context = vi.fn().mockResolvedValue({ watch, dispose: vi.fn() });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    process.argv[2] = "dev";

    await import("../../scripts/build.mjs");

    expect(watch).toHaveBeenCalled();

    process.argv.splice(2, 1);
  });

  it("logs warnings when rebuild returns warnings and no metafile", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const project = await fs.mkdtemp(path.join(os.tmpdir(), "build-proj-"));
    const fakeWarning = { text: "warn" };

    const fakeMetafile = { inputs: { "a.js": {} } };
    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [fakeWarning],
        metafile: fakeMetafile,
      }),
      dispose: vi.fn(),
    });

    const formatMessages = vi.fn().mockResolvedValue(["formatted warn"]);
    const analyzeMetafile = vi.fn();

    vi.doMock("esbuild", () => ({
      analyzeMetafile,
      formatMessages,
      context,
    }));

    await setupProject(project);

    process.chdir(project);

    await import("../../scripts/build.mjs");

    const esbuild = vi.mocked(await import("esbuild"));

    expect(esbuild.formatMessages).toHaveBeenCalled();
    // formatMessages should be called with warnings and kind 'warning'
    const calls = esbuild.formatMessages.mock.calls;
    expect(calls.some((c) => c[1].kind === "warning")).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith("formatted warn");
  });

  it("removes existing built files (main + styles) before building", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "build-proj-"));
    const mainFile = path.join(project, "main.js");
    const stylesFile = path.join(project, "styles.css");

    // create stale build artifacts that should be removed
    await fs.writeFile(mainFile, "stale");
    await fs.writeFile(stylesFile, "stale");

    await setupProject(project);

    const fakeMetafile = { inputs: { "a.js": {} } };
    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [],
        metafile: fakeMetafile,
      }),
      dispose: vi.fn(),
    });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/build.mjs");
    } finally {
      process.chdir(cwd);
    }

    expect(
      await fs
        .stat(mainFile)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(
      await fs
        .stat(stylesFile)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it("logs a warning and continues when removing previous build files fails", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "build-proj-"));

    await setupProject(project);

    // Mock rm to fail while preserving other fs/promises functions (readFile is used by utils.PACKAGE_ID)
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal();
      return Object.assign({}, actual, {
        rm: vi.fn().mockRejectedValue(new Error("boom")),
      });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const fakeMetafile = { inputs: { "a.js": {} } };
    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [],
        metafile: fakeMetafile,
      }),
      dispose: vi.fn(),
    });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/build.mjs");
    } finally {
      process.chdir(cwd);
    }

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to remove previous build output, proceeding anyway:",
      expect.any(Error),
    );
  });
});
