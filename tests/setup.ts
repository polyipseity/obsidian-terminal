import { vi } from "vitest";
import { AdvancedSettingTabMock, makeDocView } from "./helpers.js";
import { beforeEach } from "vitest";
// Must be kept as type import to avoid circular dependency issues in the mock below
import type {
  PluginContext,
  HasPrivate,
} from "@polyipseity/obsidian-plugin-library";

// Small helper types used by mocks (re-exported from `tests/helpers.ts`)

// Global stub for @polyipseity/obsidian-plugin-library to keep tests hermetic.
// `AdvancedSettingTabMock` and helper factories are imported from `tests/helpers.ts` for reuse across tests

vi.doMock("@polyipseity/obsidian-plugin-library", () => ({
  // Export a wrapper whose `register` returns a lightweight DocView.
  // Tests can override `lib.DocumentationMarkdownView.register` safely.
  DocumentationMarkdownView: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    register: (_ctx: unknown) => makeDocView(),
  },

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  SettingsManager: class {},
  NOTICE_NO_TIMEOUT: -1,
  NULL_SEM_VER_STRING: "0.0.0",
  LibraryLocales: {
    DEFAULT_LANGUAGE: "en",
    DEFAULT_NAMESPACE: "translation",
    FALLBACK_LANGUAGES: ["en"],
    FORMATTERS: {},
    RETURN_NULL: false,
    RESOURCES: { en: { translation: async () => ({}) } },
  },
  PluginContext: {
    LocalSettings: { fix: (v: unknown) => ({ value: v ?? {} }) },
    Settings: { fix: (v: unknown) => ({ value: v ?? {} }) },
  },
  cloneAsWritable: (s: Record<string, unknown> | undefined) => {
    if (s && typeof s === "object") return { ...s };
    return {};
  },
  deepFreeze: (v: unknown) => v,
  fixInSet: (
    _def: unknown,
    unc: Record<string, unknown> | undefined,
    key: string,
    set: readonly string[],
  ) => {
    if (unc && typeof unc === "object") {
      const v = unc[key];
      if (typeof v === "string" && set.includes(v)) return v;
    }
    return set[0];
  },
  fixTyped: (
    def: Record<string, unknown>,
    unc: Record<string, unknown> | undefined,
    key: string,
  ) => {
    if (unc && typeof unc === "object" && def && typeof def === "object") {
      const v = unc[key];
      return typeof v === typeof def[key] ? v : def[key];
    }
    return def[key];
  },
  launderUnchecked: (v: unknown) => (v == null ? {} : v),
  markFixed: (_orig: unknown, value: unknown) => ({ value }),
  opaqueOrDefault: (_parser: unknown, v: unknown, def: unknown) =>
    v ? v : def,
  semVerString: (s: unknown) => s,
  typedKeys: () => (o: unknown) => Object.keys(Object(o)),
  syncLocale: () => (v: unknown) => v,
  mergeResources: (a: unknown, b: unknown) =>
    Object.assign(
      {},
      (typeof a === "object" && a) || {},
      (typeof b === "object" && b) || {},
    ),

  // Typed wrappers for private API helpers from the library.
  // We use `type` imports here so the mock keeps the
  // exact function signatures the real library exposes. Tests can override
  // behavior with `vi.doMock` where necessary.
  revealPrivate: (
    context: PluginContext,
    args: readonly HasPrivate[],
    func: (...args: unknown[]) => unknown,
    fallback: (error: unknown) => unknown,
  ) => {
    try {
      // Call the provided function with the revealed args. Keep this
      // intentionally thin to mirror the real implementation.

      return func(...args);
    } catch (error) {
      // Mirror library behavior: log and return fallback
      self.console.warn(
        context.language.value.t("errors.private-API-changed"),
        error,
      );
      return fallback(error);
    }
  },

  revealPrivateAsync: async (
    context: PluginContext,
    args: readonly HasPrivate[],
    func: (...args: unknown[]) => PromiseLike<unknown>,
    fallback: (error: unknown) => unknown,
  ) => {
    try {
      return await func(...args);
    } catch (error) {
      self.console.warn(
        context.language.value.t("errors.private-API-changed"),
        error,
      );
      return fallback(error);
    }
  },

  AdvancedSettingTab: AdvancedSettingTabMock,
  closeSetting: () => {},
  linkSetting: () => ({}),
  resetButton: () => ({}),
  registerSettingsCommands: () => {},
  addCommand: (_ctx: unknown, _name: unknown, _opts: unknown) => {
    void _ctx;
    void _name;
    void _opts;
  },
  StorageSettingsManager: { hasFailed: () => false },
  printError: (_err: unknown, _msgFactory: () => string, _ctx: unknown) => {
    void _err;
    void _msgFactory;
    void _ctx;
  },
  anyToError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  toJSONOrString: (v: unknown) => String(v),
}));

// Provide a default semver lt implementation; tests can override by doMock where needed
vi.doMock("semver/functions/lt.js", () => ({
  default: () => false,
  __esModule: true,
}));

// Also mock the raw markdown imports used by `src/documentations.ts` (use absolute paths to ensure resolution)
const changelogPath = new URL("../CHANGELOG.md", import.meta.url).pathname;
const readmePath = new URL("../README.md", import.meta.url).pathname;
vi.doMock(changelogPath, () => ({
  default: "changelog contents",
  __esModule: true,
}));
vi.doMock(readmePath, () => ({ default: "readme contents", __esModule: true }));

// Ensure each test runs with a clean module registry & restored spies by default
beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});
