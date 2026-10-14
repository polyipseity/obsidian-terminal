/**
 * Unit tests for `src/settings-data.ts` — validate defaults and normalization helpers.
 */
import { cloneAsWritable } from "@polyipseity/obsidian-plugin-library";
import { describe, expect, it, vi } from "vitest";
import { LocalSettings, Settings } from "../../src/settings-data.js";
import { PROFILE_PRESETS } from "../../src/terminal/profile-presets.js";
import { inheritedPythonExecutable } from "../../src/terminal/win32-doctor.js";
import released328 from "../fixtures/data-3.28.0.json" with { type: "json" };

// Literal presets from 3.27.2 (a485e98b05f2dc0bc14e0a9d92c3d8cad6d0a95f),
// src/terminal/profile-presets.ts and constants from src/magic.ts.
// These released records predate win32Backend. 3.27.0 and 3.27.1 presets omitted
// environment; 3.27.2 added environment: [] (50aaa931).
// The generic integrated default used an empty Python
// executable, whereas these Windows-only and cross-platform presets used python3.
const RELEASED_3_27_2_PROFILES = {
  cmdIntegrated: {
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
    terminalOptions: { documentOverride: null },
    type: "integrated",
    useWin32Conhost: true,
  },
  pwshIntegrated: {
    args: [],
    environment: [],
    executable: "pwsh",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true, win32: true },
    pythonExecutable: "python3",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: ["0", "SIGINT", "SIGTERM"],
    terminalOptions: { documentOverride: null },
    type: "integrated",
    useWin32Conhost: true,
  },
};

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

  it.each([
    undefined,
    null,
    {},
    "bad",
    { hasUsedIntegratedTerminal: "true" },
    { hasUsedIntegratedTerminal: 1 },
    { hasUsedIntegratedTerminal: null },
  ])("defaults local integrated-terminal use to false for %j", (stored) => {
    expect(LocalSettings.fix(stored).value).toHaveProperty(
      "hasUsedIntegratedTerminal",
      false,
    );
  });

  it.each([false, true])(
    "preserves local integrated-terminal use %s through JSON",
    (used) => {
      const first = LocalSettings.fix({ hasUsedIntegratedTerminal: used }),
        stored: unknown = JSON.parse(JSON.stringify(first.value));
      expect(LocalSettings.fix(stored)).toMatchObject({
        valid: true,
        value: { hasUsedIntegratedTerminal: used },
      });
      expect(Settings.DEFAULT).not.toHaveProperty("hasUsedIntegratedTerminal");
    },
  );

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

  it("drops the retired discovery marker", () => {
    // The field holds only what the user typed, so nothing marks a value as
    // discovered any more.
    expect(
      Settings.fix({
        pythonExecutable: "python",
        pythonExecutableDiscovered: true,
      }).value,
    ).not.toHaveProperty("pythonExecutableDiscovered");
  });

  it.each([
    RELEASED_3_27_2_PROFILES.cmdIntegrated.platforms,
    { darwin: false, linux: false, win32: true },
    { darwin: "false", linux: 0, win32: true },
  ])(
    "migrates released Windows-only python3 after normalizing platforms: %j",
    (platforms) => {
      const fixed = Settings.Profile.fix({
        ...RELEASED_3_27_2_PROFILES.cmdIntegrated,
        platforms,
      });
      expect(fixed.value).toMatchObject({
        pythonExecutable: "",
        win32Backend: "conpty",
      });
    },
  );

  it.each([
    RELEASED_3_27_2_PROFILES.pwshIntegrated.platforms,
    { darwin: true, win32: true },
    { linux: true, win32: true },
    { darwin: true, linux: true },
    { win32: false },
    { win32: "true" },
    {},
  ])(
    "preserves stored python3 for profiles that are not Windows-only: %j",
    (platforms) => {
      const fixed = Settings.fix({
        pythonExecutable: "C:\\Plugin\\python.exe",
        profiles: {
          explicit: {
            ...RELEASED_3_27_2_PROFILES.pwshIntegrated,
            platforms,
          },
        },
      }).value;
      expect(fixed.profiles["explicit"]).toMatchObject({
        pythonExecutable: "python3",
      });
    },
  );

  it.each([
    { win32Backend: "conpty", expectedBackend: "conpty" },
    { win32Backend: "legacy", expectedBackend: "legacy" },
    { win32Backend: null, expectedBackend: "conpty" },
  ])(
    "preserves stored python3 with a defined backend: $win32Backend",
    ({ win32Backend, expectedBackend }) => {
      expect(
        Settings.Profile.fix({
          ...RELEASED_3_27_2_PROFILES.cmdIntegrated,
          win32Backend,
        }).value,
      ).toMatchObject({
        pythonExecutable: "python3",
        win32Backend: expectedBackend,
      });
    },
  );

  it.each([
    "C:\\Custom\\python.exe",
    "python",
    "my-python",
    "Python3",
    " python3",
    "python3 ",
    "python3\t",
    "",
  ])(
    "preserves other legacy Python strings exactly: %j",
    (pythonExecutable) => {
      expect(
        Settings.Profile.fix({
          ...RELEASED_3_27_2_PROFILES.cmdIntegrated,
          pythonExecutable,
        }).value,
      ).toHaveProperty("pythonExecutable", pythonExecutable);
    },
  );

  it.each([false, true])(
    "keeps a current preset clone's inherited Python (missing backend: %s)",
    (missingBackend) => {
      // Match the profile editor's clone path, including a not-yet-fixed shape.
      const cloned = cloneAsWritable(PROFILE_PRESETS.cmdIntegrated),
        { win32Backend: _win32Backend, ...withoutBackend } = cloned,
        fixed = Settings.Profile.fix(missingBackend ? withoutBackend : cloned);
      expect(cloned.pythonExecutable).toBe("");
      expect(fixed.value).toEqual(cloned);
    },
  );

  describe("fixer convergence across persistence", () => {
    /*
     * A fixer key that does not round-trip stably appends one recovery
     * snapshot per load, forever. Fix → persist → fix must be a no-op.
     */
    function expectConvergence(input: unknown): Settings {
      const first = Settings.fix(input).value,
        stored: unknown = JSON.parse(JSON.stringify(first)),
        second = Settings.fix(stored);
      expect(second.valid).toBe(true);
      expect(JSON.stringify(second.value)).toBe(JSON.stringify(first));
      return first;
    }

    it.each([
      { useWin32Conhost: true, omitEnvironment: true },
      { useWin32Conhost: false, omitEnvironment: true },
      { useWin32Conhost: true, omitEnvironment: false },
      { useWin32Conhost: false, omitEnvironment: false },
    ])(
      "converges released 3.27.x settings onto ConPTY (useWin32Conhost: $useWin32Conhost, omitted environment: $omitEnvironment)",
      ({ useWin32Conhost, omitEnvironment }) => {
        // Released settings have neither plugin-level Python nor prewarm fields.
        const released = {
            addToCommand: false,
            defaultProfile: "cmdIntegrated",
            errorNoticeTimeout: 0,
            language: "",
            noticeTimeout: 17,
            profiles: Object.fromEntries(
              Object.entries(RELEASED_3_27_2_PROFILES).map(([id, profile]) => {
                const { environment: _environment, ...olderProfile } = profile;
                return [
                  id,
                  {
                    ...(omitEnvironment ? olderProfile : profile),
                    useWin32Conhost,
                  },
                ];
              }),
            ),
          },
          fixed = expectConvergence(released),
          { profiles: _profiles, ...unrelated } = released;
        expect(fixed).toMatchObject(unrelated);
        expect(Object.keys(fixed.profiles)).toEqual(
          Object.keys(released.profiles),
        );
        for (const [id, profile] of Object.entries(RELEASED_3_27_2_PROFILES)) {
          const {
            useWin32Conhost: _useWin32Conhost,
            pythonExecutable: _pythonExecutable,
            ...preserved
          } = profile;
          expect(fixed.profiles[id]).toMatchObject({
            ...preserved,
            pythonExecutable: id === "cmdIntegrated" ? "" : "python3",
            win32Backend: "conpty",
          });
          expect(fixed.profiles[id]).not.toHaveProperty("useWin32Conhost");
        }
      },
    );

    it("converges current-era data in one cycle", () => {
      expectConvergence(JSON.parse(JSON.stringify(Settings.DEFAULT)));
    });

    it("migrates once, inherits plugin Python, and preserves a later explicit python3", () => {
      // Model released profiles with a plugin path configured after upgrading.
      const input = {
          ...Settings.DEFAULT,
          defaultProfile: "cmdIntegrated",
          noticeTimeout: 17,
          profiles: RELEASED_3_27_2_PROFILES,
          pythonExecutable: "C:\\Plugin\\python.exe",
          showTerminalTabPrefix: true,
        },
        before = cloneAsWritable(input),
        fixed = expectConvergence(input),
        profile = fixed.profiles["cmdIntegrated"];
      if (profile?.type !== "integrated") {
        throw new Error("Expected an integrated profile");
      }
      expect(profile.pythonExecutable).toBe("");
      expect(
        inheritedPythonExecutable(
          profile.pythonExecutable,
          fixed.pythonExecutable,
        ),
      ).toBe(input.pythonExecutable);
      const { profiles: _profiles, ...unrelated } = input;
      expect(fixed).toMatchObject(unrelated);
      expect(input).toEqual(before);

      const edited = expectConvergence({
        ...fixed,
        profiles: {
          ...fixed.profiles,
          cmdIntegrated: { ...profile, pythonExecutable: "python3" },
        },
      });
      expect(edited.profiles["cmdIntegrated"]).toHaveProperty(
        "pythonExecutable",
        "python3",
      );
    });

    describe("experiments", () => {
      it("Settings.DEFAULT turns no experiment on", () => {
        expect(Settings.DEFAULT.experiments).toEqual({});
      });

      // One tuple per case: `it.each` spreads a bare array into arguments.
      it.each([[undefined], [null], ["x"], [3], [[]], [true]])(
        "Settings.fix defaults experiments for %j",
        (experiments) => {
          expect(Settings.fix({ experiments }).value.experiments).toEqual({});
        },
      );

      it("Settings.fix drops unknown and malformed experiment flags", () => {
        const fixed = Settings.fix({
          experiments: { gone: true, nested: { a: 1 }, other: "yes" },
        }).value;
        expect(fixed.experiments).toEqual({});
        expect(fixed.profiles).toEqual(Settings.fix({}).value.profiles);
      });

      it("a removed experiment's flag is cleaned up in one cycle", () => {
        const current = cloneAsWritable(Settings.DEFAULT),
          [id, profile] = Object.entries(current.profiles)[0] ?? [];
        if (id === undefined || profile === undefined) {
          throw new Error("Expected a default profile");
        }
        const profiles = {
            ...current.profiles,
            [id]: { ...profile, name: "My shell" },
          },
          // The flag of an experiment that has since graduated or been removed.
          fixed = expectConvergence(
            JSON.parse(
              JSON.stringify({
                ...current,
                experiments: { gone: true },
                profiles,
              }),
            ),
          );
        expect(fixed.experiments).toEqual({});
        expect(fixed.profiles).toEqual(profiles);
      });

      it("an upgrade from 3.28.0 changes no stored setting and turns nothing on", () => {
        const released: unknown = JSON.parse(JSON.stringify(released328)),
          fixed = expectConvergence(released);
        expect(released328).not.toHaveProperty("experiments");
        expect(released328.profiles.darwinIntegratedDefault.name).toBe(
          "My shell",
        );
        expect(fixed).toMatchObject(released328);
        expect(fixed.profiles).toEqual(released328.profiles);
        expect(fixed.experiments).toEqual({});
        expect(released).toEqual(released328);
      });
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

  describe("Program status", () => {
    // Options of earlier designs of this feature, never released.
    const REMOVED_KEYS = [
        "tabStatusMarks",
        "tabStatusWorkingIndicator",
        "tabStatusPalette",
        "tabStatusTint",
        "tabStatusQuietMarks",
        "tabStatusUnreadBadge",
        "tabStatusReports",
      ],
      // The keys of the builds whose feature was an experiment: the switch
      // was `experiments.tabStatus`, and these were its look.
      EXPERIMENT_KEYS = ["tabIconSet", "tabIconSize", "tabStatusAnimation"],
      /** What `data.json` holds: the settings as written, with `extra` on top. */
      stored = (extra: Readonly<Record<string, unknown>>): unknown =>
        JSON.parse(JSON.stringify({ ...Settings.fix({}).value, ...extra })),
      /** What a build of the experiment wrote, with its switch and look. */
      experimental = (
        on: unknown,
        look: Readonly<Record<string, unknown>> = {},
      ): Readonly<Record<string, unknown>> => {
        const written = cloneAsWritable<Record<string, unknown>>({
          ...Settings.fix({}).value,
          experiments: { tabStatus: on },
          tabIconSet: "bezel",
          tabIconSize: 18,
          tabStatusAnimation: "none",
          ...look,
        });
        delete written["tabStatus"];
        return written;
      };

    it("is None until the user chooses another", () => {
      expect(Settings.DEFAULT.tabStatus).toBe("none");
      expect(Settings.fix({}).value.tabStatus).toBe("none");
    });

    it("offers None, Still and Animated, in the order the settings tab shows them", () => {
      expect(Settings.TAB_STATUSES).toEqual(["none", "still", "animated"]);
      expect(Settings.DEFAULT.tabStatus).toBe(Settings.TAB_STATUSES[0]);
    });

    it("has no setting of the tab but Program status", () => {
      expect(
        Object.keys(Settings.DEFAULT)
          .filter((key) => /^tab(?:Icon|Status)/u.test(key))
          .sort(),
      ).toEqual(["tabStatus"]);
      for (const key of [...EXPERIMENT_KEYS, ...REMOVED_KEYS]) {
        expect(Settings.DEFAULT).not.toHaveProperty(key);
      }
      for (const name of [
        "TAB_ICON_SETS",
        "TAB_ICON_SIZES",
        "TAB_STATUS_ANIMATIONS",
        "TAB_STATUS_QUIET_MARKS",
      ]) {
        expect(Settings).not.toHaveProperty(name);
      }
    });

    it.each(["none", "still", "animated"] as const)(
      "keeps a stored %s, and is valid with it",
      (tabStatus) => {
        const fixed = Settings.fix(stored({ tabStatus }));
        expect(fixed.value.tabStatus).toBe(tabStatus);
        expect(fixed.valid).toBe(true);
      },
    );

    it("replaces an unknown or mistyped Program status with None", () => {
      for (const bad of [
        "loop",
        "on",
        "",
        "Still",
        3,
        true,
        null,
        ["still"],
        { still: true },
      ]) {
        expect(Settings.fix({ tabStatus: bad }).value.tabStatus).toBe("none");
      }
    });

    describe("from the builds whose feature was an experiment", () => {
      it("turns the switch that was on into Still", () => {
        const fixed = Settings.fix(experimental(true));
        expect(fixed.value.tabStatus).toBe("still");
        // Written back once, without the old keys.
        expect(fixed.valid).toBe(false);
      });

      it("turns the switch that was on, with the dots moving, into Animated", () => {
        expect(
          Settings.fix(experimental(true, { tabStatusAnimation: "loop" })).value
            .tabStatus,
        ).toBe("animated");
      });

      it.each([
        ["none"],
        ["entry"],
        [undefined],
        [null],
        [true],
        ["LOOP"],
      ] as const)(
        "turns the switch that was on into Still under a motion of %j",
        (tabStatusAnimation) => {
          expect(
            Settings.fix(experimental(true, { tabStatusAnimation })).value
              .tabStatus,
          ).toBe("still");
        },
      );

      it.each([[false], ["true"], [1], [null], [{}], [[true]], [undefined]])(
        "leaves Program status None for a switch stored as %j, whatever the motion",
        (on) => {
          for (const tabStatusAnimation of ["none", "loop"]) {
            expect(
              Settings.fix(experimental(on, { tabStatusAnimation })).value
                .tabStatus,
            ).toBe("none");
          }
        },
      );

      it("reads the switch only as the experiment's own stored key", () => {
        // An inherited flag is not a stored flag, as the experiment's fixer read it.
        const inherited: unknown = JSON.parse(
          '{"__proto__":{"tabStatus":true}}',
        );
        expect(
          Settings.fix({ experiments: inherited, tabStatusAnimation: "loop" })
            .value.tabStatus,
        ).toBe("none");
        for (const experiments of [undefined, null, true, "tabStatus", []]) {
          expect(
            Settings.fix({ experiments, tabStatusAnimation: "loop" }).value
              .tabStatus,
            JSON.stringify(experiments),
          ).toBe("none");
        }
      });

      it("lets a stored Program status win over the switch", () => {
        for (const tabStatus of Settings.TAB_STATUSES) {
          expect(
            Settings.fix({
              ...experimental(true, { tabStatusAnimation: "loop" }),
              tabStatus,
            }).value.tabStatus,
          ).toBe(tabStatus);
        }
      });

      it("keeps none of the old keys, and the switch's flag goes with the registry", () => {
        const fixed = Settings.fix(
          experimental(true, {
            tabIconSet: "tile",
            tabIconSize: 22,
            tabStatusAnimation: "loop",
          }),
        ).value;
        for (const key of EXPERIMENT_KEYS) {
          expect(fixed).not.toHaveProperty(key);
        }
        expect(fixed.experiments).toEqual({});
        expect(fixed.tabStatus).toBe("animated");
      });

      it("converges: what is written back keeps the migrated status and is valid", () => {
        for (const [look, expected] of [
          [{ tabStatusAnimation: "loop" }, "animated"],
          [{ tabStatusAnimation: "none" }, "still"],
        ] as const) {
          const first = Settings.fix(experimental(true, look)),
            second = Settings.fix(JSON.parse(JSON.stringify(first.value)));
          expect(first.valid).toBe(false);
          expect(second.valid).toBe(true);
          expect(second.value.tabStatus).toBe(expected);
          expect(second.value).toEqual(first.value);
        }
      });
    });

    it("turns nothing on for a stored tabStatusReports", () => {
      // The switch of the builds before the experiment: never released.
      const fixed = Settings.fix(stored({ tabStatusReports: true }));
      expect(fixed.valid).toBe(false);
      expect(fixed.value).not.toHaveProperty("tabStatusReports");
      expect(fixed.value.tabStatus).toBe("none");
      expect(fixed.value.experiments).toEqual({});
    });

    it("drops the options of the earlier designs and leaves the settings beside them as they were", () => {
      const saved = { ...Settings.DEFAULT, tabStatus: "animated" },
        fixed = Settings.fix({
          ...saved,
          tabStatusMarks: "dot",
          tabStatusPalette: "semantic",
          tabStatusQuietMarks: "badge",
          tabStatusTint: "whole",
          tabStatusUnreadBadge: false,
          tabStatusWorkingIndicator: "ring",
        }).value;
      for (const key of REMOVED_KEYS) {
        expect(fixed).not.toHaveProperty(key);
      }
      expect(fixed).toEqual(Settings.fix(saved).value);
      expect(fixed.tabStatus).toBe("animated");
      expect(Settings.fix(JSON.parse(JSON.stringify(fixed))).valid).toBe(true);
    });

    it("adds None to settings saved by 3.28.0", () => {
      // 3.28.0 wrote none of these keys.
      const released: Record<string, unknown> = { ...Settings.DEFAULT };
      delete released["tabStatus"];
      released["showTerminalTabPrefix"] = true;
      const fixed = Settings.fix(released).value;
      expect(fixed.tabStatus).toBe("none");
      expect(fixed.showTerminalTabPrefix).toBe(true);
      expect(Settings.fix(JSON.parse(JSON.stringify(fixed))).valid).toBe(true);
    });
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
