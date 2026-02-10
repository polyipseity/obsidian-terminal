/**
 * Unit tests for `src/documentations.ts` (loader behaviour) — assert registration and open flows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makePluginContext,
  makeLocalSettingsManager,
  makeDocView,
  tick,
} from "../helpers.js";
import { semVerString } from "../helpers.js";

describe("loadDocumentations", () => {
  beforeEach(async () => {
    vi.resetModules();
    // ensure we can override DocumentationMarkdownView.register from the global mock
    const lib = vi.mocked(await import("@polyipseity/obsidian-plugin-library"));
    // Reset register to a default that returns an object with open spy (which tests will override as needed)
    Object.assign(lib.DocumentationMarkdownView, {
      register: vi.fn(() => makeDocView()),
    });
  });

  it("registers commands for each documentation key and opens readme if readme arg true", async () => {
    const openSpy = vi.fn().mockResolvedValue(undefined);
    // Register a DocView whose `open` delegates to our spy
    await (
      await import("../mocks/library.js")
    ).overrideDocumentationRegister(makeDocView({ open: openSpy }));

    const { loadDocumentations } = await import("../../src/documentations.js");

    const context = makePluginContext();
    // minimal overrides; prefer mutating the returned object so we preserve proper shapes
    context.addSettingTab = vi.fn();

    const ret = loadDocumentations(context, true);
    // verify the doc view registered is the one returning our spy
    expect(ret.docMdView.open).toBe(openSpy);
    // The open is scheduled asynchronously: wait a tick so the async IIFE runs
    await tick();
    // If readme == true the readme should be opened once (openSpy called)
    expect(openSpy).toHaveBeenCalled();
    // ret should have an open method
    expect(typeof ret.open).toBe("function");
  });

  it("opens changelog when version advances and updates localSettings", async () => {
    // semver lt should return true to indicate local < version
    vi.doMock("semver/functions/lt.js", () => ({
      default: () => true,
      __esModule: true,
    }));

    const openSpy = vi.fn().mockResolvedValue(undefined);
    await (
      await import("../mocks/library.js")
    ).overrideDocumentationRegister(makeDocView({ open: openSpy }));

    const { loadDocumentations } = await import("../../src/documentations.js");

    const mutate: (fn: (ls: unknown) => void) => Promise<unknown> = vi.fn(
      (fn: (ls: unknown) => void) => {
        fn({ lastReadChangelogVersion: semVerString("0.0.1") });
        return Promise.resolve();
      },
    );
    const localSettings = makeLocalSettingsManager(
      semVerString("0.0.1"),
      mutate,
    );

    const context = makePluginContext({
      version: semVerString("0.0.2"),
      localSettings,
      settings: { value: { openChangelogOnUpdate: true } },
    });
    const ret = loadDocumentations(context, false);
    // verify the doc view registered is the one returning our spy
    expect(ret.docMdView.open).toBe(openSpy);
    // The open is scheduled asynchronously: wait a tick so the async IIFE runs
    await tick();
    // Because version != null and semverLt(...) === true, the changelog open should be scheduled
    // The loadDocumentations implementation calls ret.open("changelog", false) synchronously
    // which results in openSpy being called
    expect(openSpy).toHaveBeenCalled();
    // Ensure mutate() was called to update lastReadChangelogVersion
    expect(mutate).toHaveBeenCalled();
  });

  it("prints an error when a documentation open fails", async () => {
    const openSpy = vi.fn().mockRejectedValue(new Error("boom"));
    await (
      await import("../mocks/library.js")
    ).overrideDocumentationRegister(makeDocView({ open: openSpy }));
    const lib = vi.mocked(await import("@polyipseity/obsidian-plugin-library"));
    lib.printError = vi.fn();

    const { loadDocumentations } = await import("../../src/documentations.js");

    const context = makePluginContext({
      version: null,
      settings: { value: { openChangelogOnUpdate: true } },
      addSettingTab: vi.fn(),
    });

    loadDocumentations(context, true);
    // wait a tick for the scheduled open to execute
    await tick();

    expect(lib.printError).toHaveBeenCalled();
  });

  it("does not open changelog when semver.lt indicates no update", async () => {
    vi.doMock("semver/functions/lt.js", () => ({
      default: () => false,
      __esModule: true,
    }));

    const openSpy = vi.fn().mockResolvedValue(undefined);
    await (
      await import("../mocks/library.js")
    ).overrideDocumentationRegister(makeDocView({ open: openSpy }));

    const { loadDocumentations } = await import("../../src/documentations.js");

    const mutate = vi.fn();
    const localSettings = makeLocalSettingsManager(
      semVerString("0.0.1"),
      mutate,
    );
    const context = makePluginContext({
      version: semVerString("0.0.2"),
      localSettings,
      settings: { value: { openChangelogOnUpdate: true } },
    });
    loadDocumentations(context, false);
    await tick();
    expect(openSpy).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
