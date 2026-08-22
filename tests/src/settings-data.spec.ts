/**
 * Unit tests for `src/settings-data.ts` — validate defaults and normalization helpers.
 */
import { describe, expect, it, vi } from "vitest";
import { LocalSettings, Settings } from "../../src/settings-data.js";

describe("src/settings-data.ts", () => {
  it("Settings.DEFAULT has expected keys and types", () => {
    expect(Settings.DEFAULT).toHaveProperty("noticeTimeout");
    expect(typeof Settings.DEFAULT.noticeTimeout).toBe("number");
    expect(Settings.DEFAULT).toHaveProperty("openChangelogOnUpdate");
    expect(typeof Settings.DEFAULT.openChangelogOnUpdate).toBe("boolean");
    expect(Settings.DEFAULT).toHaveProperty("showTerminalTabPrefix");
    expect(Settings.DEFAULT.showTerminalTabPrefix).toBe(false);
    expect(Settings.DEFAULT).toHaveProperty("terminalOptions");
    expect(typeof Settings.DEFAULT.terminalOptions).toBe("object");
    // should at least include the documentOverride property from the preset
    expect(
      Object.prototype.hasOwnProperty.call(
        Settings.DEFAULT.terminalOptions,
        "documentOverride",
      ),
    ).toBe(true);
  });

  it("DEFAULTABLE_LANGUAGES includes empty string and is an array", () => {
    expect(Array.isArray(Settings.DEFAULTABLE_LANGUAGES)).toBe(true);
    expect(Settings.DEFAULTABLE_LANGUAGES).toContain("");
  });

  it("Settings.fix coerces bad typed values to defaults", () => {
    // provide clearly wrong types including terminalOptions
    const bad = {
      errorNoticeTimeout: "not-a-number",
      language: "invalid-language",
      noticeTimeout: "x",
      openChangelogOnUpdate: "truthy",
      terminalOptions: "not-an-object",
    };
    const fixed = Settings.fix(bad);
    expect(typeof fixed.value.noticeTimeout).toBe("number");
    expect(typeof fixed.value.openChangelogOnUpdate).toBe("boolean");
    // invalid options should be replaced with DEFAULT
    expect(fixed.value.terminalOptions).toEqual(
      Settings.DEFAULT.terminalOptions,
    );
  });

  it("LocalSettings survives a JSON persistence round trip as valid", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    // `StorageSettingsManager.write` persists `JSON.stringify(value)`, which
    // drops undefined-valued keys. The next load must not flag that stored
    // shape as malformed, or every startup appends a recovery entry.
    const first = LocalSettings.fix(null),
      stored: unknown = JSON.parse(JSON.stringify(first.value));
    expect(LocalSettings.fix(stored).valid).toBe(true);
  });

  it("LocalSettings.fix ensures lastReadChangelogVersion exists and is a string", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const fixed = LocalSettings.fix({});
    expect(fixed.value).toHaveProperty("lastReadChangelogVersion");
    expect(typeof fixed.value.lastReadChangelogVersion).toBe("string");

    // semver parsing of an undefined value will be logged via opaqueOrDefault()
    const [debugCall] = debugSpy.mock.calls;
    expect(debugCall?.[0]).toHaveProperty(
      "message",
      expect.stringContaining("Invalid Version: undefined"),
    );
  });

  it("Profile.DEFAULTS exposes an empty environment for shell profiles", () => {
    expect(Settings.Profile.DEFAULTS.external.environment).toEqual([]);
    expect(Settings.Profile.DEFAULTS.integrated.environment).toEqual([]);
  });

  it("Profile.fix coerces a bad environment to the empty default", () => {
    const external = Settings.Profile.fix({
      type: "external",
      environment: "not-an-array",
    }).value;
    expect(external.type).toBe("external");
    expect((external as Settings.Profile.External).environment).toEqual([]);

    const integrated = Settings.Profile.fix({
      type: "integrated",
      environment: [["FOO", "bar"]],
    }).value;
    expect((integrated as Settings.Profile.Integrated).environment).toEqual([
      ["FOO", "bar"],
    ]);
  });

  it("Profile.fix drops invalid environment entries silently", () => {
    // Old string format entries and malformed entries should be dropped,
    // not crash the fix function.
    const result = Settings.Profile.fix({
      type: "external",
      environment: ["FOO=bar", ["KEY", "value"], [42, "value"], ["KEY"]],
    }).value;
    expect((result as Settings.Profile.External).environment).toEqual([
      ["KEY", "value"],
    ]);
  });

  it("normalizes the Windows backend selector", () => {
    // Presentation order for the profile editor; the default is ConPTY.
    expect(Settings.Profile.WIN32_BACKENDS).toEqual(["conpty", "legacy"]);
    expect(Settings.Profile.DEFAULTS.integrated.win32Backend).toBe("conpty");
    const conpty = Settings.Profile.fix({
        type: "integrated",
        win32Backend: "conpty",
      }).value,
      legacy = Settings.Profile.fix({
        type: "integrated",
        win32Backend: "legacy",
      }).value;
    expect(conpty).toMatchObject({
      type: "integrated",
      win32Backend: "conpty",
    });
    expect(legacy).toMatchObject({
      type: "integrated",
      win32Backend: "legacy",
    });
    expect(conpty).not.toHaveProperty("useWin32Conhost");
    expect(legacy).not.toHaveProperty("useWin32Conhost");
  });

  it("moves a stored ConHost boolean onto the default backend", () => {
    // useWin32Conhost is retired: either value adopts the default and the
    // key is dropped.
    for (const useWin32Conhost of [true, false]) {
      const fixed = Settings.Profile.fix({
        type: "integrated",
        useWin32Conhost,
      }).value;
      expect(fixed).toMatchObject({ win32Backend: "conpty" });
      expect(fixed).not.toHaveProperty("useWin32Conhost");
    }
  });

  it("rejects unknown Windows backend values", () => {
    expect(
      Settings.Profile.fix({
        type: "integrated",
        win32Backend: "shell-pipes",
      }).value,
    ).toMatchObject({ win32Backend: "conpty" });
  });

  it("defaults the plugin-level Python executable to automatic discovery", () => {
    expect(Settings.DEFAULT.pythonExecutable).toBe("");
    expect(
      Settings.fix({ pythonExecutable: "C:\\Python312\\python.exe" }).value
        .pythonExecutable,
    ).toBe("C:\\Python312\\python.exe");
    expect(Settings.fix({ pythonExecutable: 42 }).value.pythonExecutable).toBe(
      "",
    );
  });

  it("records backend demotion provenance on integrated profiles", () => {
    expect(Settings.Profile.DEFAULTS.integrated.win32BackendAutoDemoted).toBe(
      false,
    );
    // A demoted profile keeps its marker; anything else reads as the user's
    // own choice.
    expect(
      Settings.Profile.fix({
        type: "integrated",
        win32Backend: "legacy",
        win32BackendAutoDemoted: true,
      }).value,
    ).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
    expect(Settings.Profile.fix({ type: "integrated" }).value).toMatchObject({
      win32BackendAutoDemoted: false,
    });
    expect(
      Settings.Profile.fix({
        type: "integrated",
        win32BackendAutoDemoted: "yes",
      }).value,
    ).toMatchObject({ win32BackendAutoDemoted: false });
  });

  describe("fixer convergence across persistence", () => {
    /*
     * A fixer key that does not round-trip stably appends one recovery
     * snapshot per load, forever. Fix → persist → fix must be a no-op.
     */
    function expectConvergence(input: unknown): void {
      const first = Settings.fix(input).value,
        stored: unknown = JSON.parse(JSON.stringify(first)),
        second = Settings.fix(stored);
      expect(second.valid).toBe(true);
      expect(JSON.parse(JSON.stringify(second.value))).toEqual(stored);
    }

    it("converges main-era data in one cycle", () => {
      expectConvergence({
        addToCommand: true,
        defaultProfile: "upgrade",
        errorNoticeTimeout: 0,
        language: "",
        noticeTimeout: 5,
        profiles: {
          upgrade: {
            args: [],
            environment: [],
            executable: "C:\\Windows\\System32\\cmd.exe",
            followTheme: true,
            name: "",
            platforms: { win32: true },
            pythonExecutable: "python3",
            restoreHistory: false,
            rightClickAction: "copyPaste",
            successExitCodes: ["0", "SIGINT", "SIGTERM"],
            terminalOptions: { documentOverride: null, fontSize: 14 },
            type: "integrated",
            useWin32Conhost: true,
          },
        },
      });
    });

    it("converges current-era data in one cycle", () => {
      expectConvergence(JSON.parse(JSON.stringify(Settings.DEFAULT)));
    });
  });

  it("Settings.fix validates defaultProfile against available profiles", () => {
    const baseProfiles = {
      foo: Settings.Profile.DEFAULTS.external,
      bar: Settings.Profile.DEFAULTS.integrated,
    };
    const good = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: "foo",
    });
    expect(good.value.defaultProfile).toBe("foo");

    const bad = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: "doesnotexist",
    });
    expect(bad.value.defaultProfile).toBe(null);

    // null should be preserved and empty-string coerced to null
    const nullVal = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: null,
    });
    expect(nullVal.value.defaultProfile).toBe(null);
    const emptyString = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: "",
    });
    expect(emptyString.value.defaultProfile).toBe(null); // empty string is not treated specially
    // even when the input is wrong type, it should coerce to null
    const alsoBad = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: 123,
    });
    expect(alsoBad.value.defaultProfile).toBe(null);
  });

  it("Settings.fix preserves valid showTerminalTabPrefix", () => {
    const enabled = Settings.fix({ showTerminalTabPrefix: true });
    expect(enabled.value.showTerminalTabPrefix).toBe(true);

    const disabled = Settings.fix({ showTerminalTabPrefix: false });
    expect(disabled.value.showTerminalTabPrefix).toBe(false);
  });

  it("Settings.fix coerces bad showTerminalTabPrefix to default", () => {
    const bad = Settings.fix({
      showTerminalTabPrefix: "not-a-boolean",
    });
    expect(bad.value.showTerminalTabPrefix).toBe(false);
  });

  describe("Settings.Profile.defaultEntryOfType", () => {
    it("returns [key, profile] tuple for matching profile", () => {
      const profiles: Settings.Profiles = {
        abc123: {
          ...Settings.Profile.DEFAULTS.integrated,
          type: "integrated",
        },
        def456: {
          ...Settings.Profile.DEFAULTS.developerConsole,
          type: "developerConsole",
        },
      };
      const result = Settings.Profile.defaultEntryOfType(
        "integrated",
        profiles,
      );
      expect(result).not.toBeNull();
      const [key, profile] = result ?? ["", {} as Settings.Profile];
      expect(key).toBe("abc123");
      expect(profile.type).toBe("integrated");
    });

    it("returns null when no profile matches", () => {
      const profiles: Settings.Profiles = {};
      expect(
        Settings.Profile.defaultEntryOfType("integrated", profiles),
      ).toBeNull();
    });
  });
});
