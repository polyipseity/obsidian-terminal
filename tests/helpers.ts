/**
 * tests/helpers.ts
 *
 * Lightweight, documented test helpers used across unit tests.
 * Goals:
 *  - Reduce duplication by centralizing mock creation
 *  - Provide strongly typed factories to avoid `as` casts in individual tests
 *  - Keep implementations minimal and easy to stub / spy on
 */

import { vi } from "vitest";
import { PLACEHOLDERPlugin } from "../src/main.js";
import type { loadDocumentations } from "../src/documentations.js";
import { DeepPartial } from "ts-essentials";
import { LocalSettings } from "./settings-data.js";
// Must be kept as type import to avoid circular dependency issues
import type {
  SemVerString,
  StorageSettingsManager,
} from "@polyipseity/obsidian-plugin-library";

/**
 * Create a SemVerString opaque type from a string.
 * Note: does not validate the string format.
 */
export function semVerString(value: string): SemVerString {
  // Cast to SemVerString opaque type
  return value as SemVerString;
}

/**
 * Reusable DocView shape used by the library under test
 */
export interface DocView {
  open: (active?: boolean, opts?: unknown) => Promise<void>;
  context?: unknown;
}

/**
 * Generic, small helper to create a shallow mock from a base object.
 * Preserves the base's type while allowing partial overrides in tests.
 */
export function makeMock<T>(base: T, overrides?: DeepPartial<T>): T {
  return Object.assign({}, base, overrides) as T;
}

/**
 * Create a lightweight DocView with a spied `open` method.
 * This is the canonical factory for doc views used by tests.
 */
export function makeDocView(overrides: Partial<DocView> = {}): DocView {
  const base: DocView = {
    open: vi.fn().mockResolvedValue(undefined),
    context: {},
  };
  return makeMock<DocView>(base, overrides);
}

/**
 * Minimal AdvancedSettingTab-like mock used by settings-related tests.
 * Only implements behaviors tests need: a `ui.newSetting` helper and small lifecycle stubs.
 */
export class AdvancedSettingTabMock {
  public ui: { newSetting: (cont: unknown, f: (arg: unknown) => void) => void };

  /**
   * Create a new instance bound to `context` (left opaque to match production signatures).
   * The `ui.newSetting` helper immediately invokes the provided callback with an empty
   * placeholder — this keeps tests simple while allowing spies to be attached.
   */
  constructor(public context: unknown) {
    this.ui = {
      newSetting: (_cont: unknown, f: (arg: unknown) => void) => f({}),
    };
  }

  /**
   * Lightweight lifecycle hooks (no-op but present for completeness)
   */
  public onLoad(): void {}
  public newDescriptionWidget(): void {}
  public newLanguageWidget(): void {}
  public newAllSettingsWidget(): void {}
  public newSectionWidget(): void {}
  public newNoticeTimeoutWidget(): void {}
  public postMutate(): void {}

  /**
   * Snapshot helper used by a small number of tests; returns a serializable object
   */
  public snapshot0(): Record<string, unknown> {
    return {};
  }
}

/**
 * Create a mock `PLACEHOLDERPlugin` instance with sane defaults for tests.
 * Accepts partial overrides to keep tests concise.
 * NOTE: prefer small, focused overrides in tests instead of large object literals.
 */
export function makePluginContext(
  overrides: DeepPartial<PLACEHOLDERPlugin> = {},
): PLACEHOLDERPlugin {
  const base = {
    version: null,
    language: { value: { t: (k: string) => k } },
    localSettings: {
      value: { lastReadChangelogVersion: "0.0.0" },
      mutate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
    },
    settings: {
      value: { openChangelogOnUpdate: true },
      mutate: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
    },
    addSettingTab: (_tab: unknown) => {
      void _tab;
    },
  } as unknown as PLACEHOLDERPlugin;

  return makeMock<PLACEHOLDERPlugin>(base, overrides);
}

/**
 * Create a `loadDocumentations.Loaded` shaped object used by documentation tests.
 * Accepts overrides so tests can stub `open` or provide a custom `docMdView`.
 */
export function makeLoadedDoc(
  overrides: Partial<loadDocumentations.Loaded> = {},
): loadDocumentations.Loaded {
  const base = {
    open: vi.fn().mockResolvedValue(undefined),
    docMdView: makeDocView(),
  } as unknown as loadDocumentations.Loaded;

  return makeMock<loadDocumentations.Loaded>(base, overrides);
}

/**
 * Minimal StorageSettingsManager-like mock for `localSettings` tests.
 * By default it uses a simple mutate implementation that applies the change
 * synchronously to an object containing `lastReadChangelogVersion`.
 */
export function makeLocalSettingsManager(
  lastReadChangelogVersion = semVerString("0.0.0"),
  mutate?: (fn: (ls: unknown) => void) => Promise<unknown>,
): StorageSettingsManager<LocalSettings> {
  const m =
    mutate ??
    (vi.fn().mockImplementation(async (fn: (ls: unknown) => void) => {
      fn({ lastReadChangelogVersion });
      return Promise.resolve();
    }) as unknown as (fn: (ls: unknown) => void) => Promise<unknown>);
  const base: StorageSettingsManager<LocalSettings> = {
    value: { lastReadChangelogVersion },
    mutate: m,
    write: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageSettingsManager<LocalSettings>;

  return makeMock<StorageSettingsManager<LocalSettings>>(base);
}

/**
 * Wait for the next macrotask tick — useful to await scheduled IIFEs or setImmediate usage
 * in the library code under test.
 */
export function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/**
 * Small helper to cast values to records for assertions without repeating inline casts.
 */
export function toRecord<
  T extends Record<string | number | symbol, unknown> = Record<
    string | number | symbol,
    unknown
  >,
>(v: unknown): T {
  return v as T;
}
