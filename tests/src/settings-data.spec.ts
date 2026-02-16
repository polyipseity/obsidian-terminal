/**
 * Unit tests for `src/settings-data.ts` — validate defaults and normalization helpers.
 */
import { vi, describe, it, expect } from "vitest";
import { Settings, LocalSettings } from "../../src/settings-data.js";

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
    const p = Settings.persistent(sample);
    expect(p).toHaveProperty("noticeTimeout");
    // ensure extra is still present because `optionals` is empty
    expect(p).toHaveProperty("extra");
    expect(p).property("extra").equals("present");
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
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const fixed = LocalSettings.fix({});
    expect(fixed.value).toHaveProperty("lastReadChangelogVersion");
    expect(typeof fixed.value.lastReadChangelogVersion).toBe("string");

    // semver parsing of an undefined value will be logged via opaqueOrDefault()
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Invalid Version: undefined"),
      }),
    );
  });
});
