/**
 * Unit tests for `src/settings-data.ts` — validate defaults and normalization helpers.
 */
import { describe, it, expect } from "vitest";
import { Settings, LocalSettings } from "../../src/settings-data.js";
import { toRecord } from "../helpers.js";

describe("src/settings-data.ts", () => {
  it("Settings.DEFAULT has expected keys and types", () => {
    expect(Settings.DEFAULT).toHaveProperty("noticeTimeout");
    expect(typeof Settings.DEFAULT.noticeTimeout).toBe("number");
    expect(Settings.DEFAULT).toHaveProperty("openChangelogOnUpdate");
    expect(typeof Settings.DEFAULT.openChangelogOnUpdate).toBe("boolean");
  });

  it("DEFAULTABLE_LANGUAGES includes empty string and is an array", () => {
    expect(Array.isArray(Settings.DEFAULTABLE_LANGUAGES)).toBe(true);
    expect(Settings.DEFAULTABLE_LANGUAGES).toContain("");
  });

  it("persistent removes optional keys (no-op when none) but returns writable copy", () => {
    const sample = {
      errorNoticeTimeout: Settings.DEFAULT.errorNoticeTimeout,
      language: Settings.DEFAULT.language,
      noticeTimeout: Settings.DEFAULT.noticeTimeout,
      openChangelogOnUpdate: Settings.DEFAULT.openChangelogOnUpdate,
      extra: "present",
    };
    // Use toRecord to assert type for test ergonomics
    const p = Settings.persistent(toRecord(sample));
    expect(p).toHaveProperty("noticeTimeout");
    // ensure extra is still present because `optionals` is empty
    expect(toRecord(p).extra).toBe("present");
  });

  it("Settings.fix coerces bad typed values to defaults", () => {
    // provide clearly wrong types
    const bad = {
      errorNoticeTimeout: "not-a-number",
      language: "invalid-language",
      noticeTimeout: "x",
      openChangelogOnUpdate: "truthy",
    };
    const fixed = Settings.fix(bad);
    expect(typeof fixed.value.noticeTimeout).toBe("number");
    expect(typeof fixed.value.openChangelogOnUpdate).toBe("boolean");
  });

  it("LocalSettings.fix ensures lastReadChangelogVersion exists and is a string", () => {
    const fixed = LocalSettings.fix({});
    expect(fixed.value).toHaveProperty("lastReadChangelogVersion");
    expect(typeof fixed.value.lastReadChangelogVersion).toBe("string");
  });
});
