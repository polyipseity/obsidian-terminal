import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration tests for scripts/build.mjs — uses mocked esbuild
// to verify top-level behaviour such as writing a metafile and
// calling watch in dev mode.

describe("scripts/build.mjs", () => {
  let cwd;
  beforeEach(() => {
    cwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(cwd);
    process.argv[2] = undefined;
  });

  it("writes metafile and logs errors when rebuild returns errors and metafile", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));

    const fakeMetafile = { inputs: { "a.js": {} } };
    const fakeError = { text: "err" };
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn().mockResolvedValue("ANALYSIS"),
      formatMessages: vi.fn().mockResolvedValue(["formatted error"]),
      context: vi.fn().mockResolvedValue({
        rebuild: vi.fn().mockResolvedValue({
          errors: [fakeError],
          warnings: [],
          metafile: fakeMetafile,
        }),
        dispose: vi.fn().mockResolvedValue(),
      }),
    }));

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/build.mjs");
    } finally {
      process.chdir(cwd);
    }

    const esbuild = vi.mocked(await import("esbuild"));
    const { rebuild: rebuildSpy, dispose: disposeSpy } =
      await esbuild.context.mock.results[0].value;

    expect(rebuildSpy).toHaveBeenCalled();
    expect(disposeSpy).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile.mock.calls[0][0]).toHaveProperty("inputs");
    expect(esbuild.formatMessages).toHaveBeenCalled();

    const mf = JSON.parse(
      fs.readFileSync(path.join(project, "metafile.json"), "utf-8"),
    );
    expect(mf).toEqual(fakeMetafile);
  });

  it("calls watch when argv contains 'dev'", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));
    process.chdir(project);

    const watch = vi.fn().mockResolvedValue();
    const context = vi.fn().mockResolvedValue({ watch, dispose: vi.fn() });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    process.argv[2] = "dev";

    await import("../../scripts/build.mjs");

    expect(watch).toHaveBeenCalled();

    process.argv[2] = undefined;
  });

  it("logs warnings when rebuild returns warnings and no metafile", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));
    const fakeWarning = { text: "warn" };

    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [fakeWarning],
        metafile: undefined,
      }),
      dispose: vi.fn().mockResolvedValue(),
    });

    const formatMessages = vi.fn().mockResolvedValue(["formatted warn"]);
    const analyzeMetafile = vi.fn();

    vi.doMock("esbuild", () => ({
      analyzeMetafile,
      formatMessages,
      context,
    }));

    process.chdir(project);

    await import("../../scripts/build.mjs");

    const esbuild = vi.mocked(await import("esbuild"));
    expect(esbuild.formatMessages).toHaveBeenCalled();
    // formatMessages should be called with warnings and kind 'warning'
    const calls = esbuild.formatMessages.mock.calls;
    expect(calls.some((c) => c[1] && c[1].kind === "warning")).toBe(true);
  });
});
