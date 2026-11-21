/**
 * Unit tests for `src/profile-choice.ts`: a device's default profile and
 * profile order, and how the first start of this version takes them over.
 */
import {
  Platform,
  StorageSettingsManager,
} from "@polyipseity/obsidian-plugin-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceDefaultProfile,
  deviceDefaultProfileId,
  deviceProfileEntries,
  migrateProfileChoice,
  resetProfiles,
  saveProfileList,
} from "../../src/profile-choice.js";
import { LocalSettings, Settings } from "../../src/settings-data.js";
import { pythonSettingsContext } from "../fixtures/python-settings-ui.js";

const platform = vi.hoisted((): { current: Platform.All } => ({
  current: "darwin",
}));
vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get CURRENT() {
        return platform.current;
      },
    },
  };
});

const integrated = Settings.Profile.DEFAULTS.integrated,
  // data.json; this device is a Mac.
  synced = {
    defaultProfile: "zsh",
    profiles: {
      pwsh: { ...integrated, name: "pwsh", platforms: { win32: true } },
      zsh: { ...integrated, name: "zsh", platforms: { darwin: true } },
      bash: { ...integrated, name: "bash", platforms: { darwin: true } },
    },
  },
  // Local settings as 3.29.0 writes them: no default profile, no order.
  released3290 = {
    recovery: {},
    hasUsedIntegratedTerminal: true,
    lastReadChangelogVersion: "3.29.0",
  };

/** A plugin with data.json `initial` and this device's store `local`. */
async function deviceContext(initial: unknown, local: unknown) {
  const context = await pythonSettingsContext(initial);
  Object.assign(context.localSettings, {
    value: LocalSettings.fix(local).value,
  });
  return {
    context,
    mutate: vi.spyOn(context.localSettings, "mutate"),
    write: vi.spyOn(context.localSettings, "write"),
    writeSettings: vi.spyOn(context.settings, "write"),
  };
}

afterEach(() => {
  platform.current = "darwin";
  vi.restoreAllMocks();
});

describe("first start of this version", () => {
  it("takes over the default profile of data.json when it runs on this device", async () => {
    const { context, write, writeSettings } = await deviceContext(
      synced,
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value).toMatchObject({
      ...released3290,
      defaultProfile: "zsh",
      profileOrder: ["pwsh", "zsh", "bash"],
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeSettings).not.toHaveBeenCalled();
    expect(context.settings.value.defaultProfile).toBe("zsh");
  });

  it("starts without a default profile when the one in data.json does not run here", async () => {
    const { context } = await deviceContext(
      { ...synced, defaultProfile: "pwsh" },
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBeNull();
    expect(context.localSettings.value.profileOrder).toEqual([
      "pwsh",
      "zsh",
      "bash",
    ]);
  });

  it("starts without a default profile when data.json has none", async () => {
    const { context } = await deviceContext(
      { ...synced, defaultProfile: null },
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBeNull();
  });

  it("never takes over a property that every object inherits", async () => {
    const { context } = await deviceContext(synced, released3290);
    // The settings fixer drops such an id; a value in memory is checked too.
    Object.assign(context.settings, {
      value: { ...context.settings.value, defaultProfile: "constructor" },
    });
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBeNull();
  });

  it("takes the default profile on Windows from the same data.json", async () => {
    platform.current = "win32";
    const { context } = await deviceContext(
      { ...synced, defaultProfile: "pwsh" },
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBe("pwsh");
  });

  it("leaves a new or cleared store alone", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { context, mutate, write } = await deviceContext(synced, null);
    await migrateProfileChoice(context);
    expect(mutate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: null,
      profileOrder: [],
    });
  });

  it("runs once", async () => {
    const { context, write } = await deviceContext(synced, released3290);
    await migrateProfileChoice(context);
    await migrateProfileChoice(context);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("takes over only what the store lacks", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "bash",
    });
    await migrateProfileChoice(context);
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: "bash",
      profileOrder: ["pwsh", "zsh", "bash"],
    });
  });

  it("keeps the choice for this session when the store cannot be written", async () => {
    const { context, write } = await deviceContext(synced, released3290),
      error = new Error("QuotaExceededError"),
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    write.mockRejectedValueOnce(error);
    await expect(migrateProfileChoice(context)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(error);
    expect(context.localSettings.value.defaultProfile).toBe("zsh");
  });

  it("starts without a choice when the store cannot be changed", async () => {
    const { context, mutate, writeSettings } = await deviceContext(
        synced,
        released3290,
      ),
      error = new Error("DataCloneError"),
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mutate.mockRejectedValueOnce(error);
    await expect(migrateProfileChoice(context)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(error);
    expect(deviceDefaultProfile(context)).toBeNull();
    expect(deviceProfileEntries(context).map(([id]) => id)).toEqual([
      "pwsh",
      "zsh",
      "bash",
    ]);
    expect(writeSettings).not.toHaveBeenCalled();
  });

  // Each platform takes over the default only when it can open it.
  it.each([
    ["win32", ["pwsh", "console"]],
    ["darwin", ["zsh", "console"]],
    ["linux", ["bash", "console"]],
    ["android", ["console"]],
    ["ios", ["console"]],
    ["unknown", ["console"]],
  ] as const)(
    "takes over a default of data.json that runs on %s",
    async (current, runs) => {
      expect(Platform.ALL).toContain(current);
      platform.current = current;
      const profiles = {
        pwsh: { ...integrated, name: "pwsh", platforms: { win32: true } },
        zsh: { ...integrated, name: "zsh", platforms: { darwin: true } },
        bash: { ...integrated, name: "bash", platforms: { linux: true } },
        console: Settings.Profile.DEFAULTS.developerConsole,
      };
      for (const id of Object.keys(profiles)) {
        const { context } = await deviceContext(
            { defaultProfile: id, profiles },
            released3290,
          ),
          expected = (runs as readonly string[]).includes(id) ? id : null;
        await migrateProfileChoice(context);
        expect([id, context.localSettings.value.defaultProfile]).toEqual([
          id,
          expected,
        ]);
        expect([id, deviceDefaultProfile(context)?.[0] ?? null]).toEqual([
          id,
          expected,
        ]);
        expect(context.settings.value.defaultProfile).toBe(id);
      }
    },
  );

  it("keeps the recovery copies of a store that 3.29.0 wrote", async () => {
    const recovery = {
        "settings.2026-10-01T00:00:00.000Z": '{"profiles":{}}',
        "local-settings.2026-10-02T00:00:00.000Z": "[]",
      },
      stored = { ...released3290, recovery };
    expect(LocalSettings.fix(stored).valid).toBe(true);
    const { context } = await deviceContext(synced, stored);
    await migrateProfileChoice(context);
    expect(context.localSettings.value).toEqual({
      ...stored,
      defaultProfile: "zsh",
      profileOrder: ["pwsh", "zsh", "bash"],
    });
  });
});

describe("this device's store as the plugin saves it", () => {
  // The library's store, as in `main.ts`, over this device's storage.
  const key = "r3291-vault.terminal.settings",
    items = new Map<string, string>(),
    storage: Storage = {
      get length(): number {
        return items.size;
      },
      clear: (): void => {
        items.clear();
      },
      getItem: (name: string): string | null => items.get(name) ?? null,
      key: (index: number): string | null => [...items.keys()][index] ?? null,
      removeItem: (name: string): void => {
        items.delete(name);
      },
      setItem: (name: string, value: string): void => {
        items.set(name, value);
      },
    },
    stored = (): unknown => JSON.parse(items.get(key) ?? "null");

  afterEach(() => {
    items.clear();
  });

  /** A start of the plugin in one vault on this device. */
  async function start(appId: () => string = () => "r3291-vault") {
    const context = await pythonSettingsContext(synced);
    Object.assign(context, { manifest: { id: "terminal" } });
    Object.defineProperty(context.app, "appId", { get: appId });
    Object.assign(context.language, { onLoaded: Promise.resolve() });
    const manager = new StorageSettingsManager(
      context,
      LocalSettings.fix,
      storage,
    );
    manager.load();
    await manager.onLoaded;
    Object.assign(context, { localSettings: manager });
    return context;
  }

  it("takes over a store that 3.29.0 saved once, without a malformed-data report", async () => {
    const malformed = vi.spyOn(console, "error");
    items.set(key, JSON.stringify(released3290));
    const context = await start();
    expect(context.localSettings.value).toEqual(released3290);
    await migrateProfileChoice(context);
    await vi.waitFor(() => {
      expect(stored()).toEqual({
        ...released3290,
        defaultProfile: "zsh",
        profileOrder: ["pwsh", "zsh", "bash"],
      });
    });
    // The next start reads it as saved and takes nothing over.
    const next = await start(),
      mutate = vi.spyOn(next.localSettings, "mutate");
    await migrateProfileChoice(next);
    expect(mutate).not.toHaveBeenCalled();
    expect(next.localSettings.value).toEqual(stored());
    expect(deviceDefaultProfile(next)?.[0]).toBe("zsh");
    expect(malformed).not.toHaveBeenCalled();
  });

  it("saves a new device's empty choice and leaves it empty", async () => {
    const malformed = vi.spyOn(console, "error"),
      context = await start(),
      mutate = vi.spyOn(context.localSettings, "mutate");
    await migrateProfileChoice(context);
    expect(mutate).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(stored()).toMatchObject({
        defaultProfile: null,
        profileOrder: [],
      });
    });
    expect(deviceDefaultProfile(context)).toBeNull();
    expect(malformed).not.toHaveBeenCalled();
  });

  it("saves every edit of this device's choice so that the next start reads it as it is", async () => {
    const malformed = vi.spyOn(console, "error");
    items.set(key, JSON.stringify(released3290));
    const context = await start();
    await migrateProfileChoice(context);
    // The store takes the writers' values as given; only a start fixes them.
    const fish = { ...integrated, name: "fish", platforms: { darwin: true } },
      added: Settings.Profile.Entry[] = [
        ["fish", fish],
        ...deviceProfileEntries(context),
      ];
    await saveProfileList(context, {
      defaultProfile: "fish" as Settings.DefaultProfile,
      entries: added.reverse(),
    });
    await context.localSettings.write();
    expect((await start()).localSettings.value).toEqual(stored());
    await saveProfileList(context, {
      defaultProfile: "fish" as Settings.DefaultProfile,
      entries: deviceProfileEntries(context).filter(([id]) => id !== "fish"),
    });
    await context.localSettings.write();
    expect((await start()).localSettings.value).toEqual(stored());
    await resetProfiles(context);
    await context.localSettings.write();
    const next = await start();
    expect(next.localSettings.value).toEqual(stored());
    expect(stored()).toMatchObject({ defaultProfile: null, profileOrder: [] });
    expect(malformed).not.toHaveBeenCalled();
  });

  it("keeps a separate choice for each vault on this device", async () => {
    items.set(key, JSON.stringify(released3290));
    const upgraded = await start(),
      added = await start(() => "r3291-other-vault");
    await migrateProfileChoice(upgraded);
    await migrateProfileChoice(added);
    expect(deviceDefaultProfile(upgraded)?.[0]).toBe("zsh");
    expect(deviceDefaultProfile(added)).toBeNull();
    await vi.waitFor(() => {
      expect(
        JSON.parse(items.get("r3291-other-vault.terminal.settings") ?? "null"),
      ).toMatchObject({ defaultProfile: null, profileOrder: [] });
    });
    expect(stored()).toMatchObject({ defaultProfile: "zsh" });
  });

  it("treats unreadable saved text as a new device", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    items.set(key, "{not json");
    const context = await start();
    await migrateProfileChoice(context);
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: null,
      profileOrder: [],
    });
    expect(deviceDefaultProfile(context)).toBeNull();
  });

  it("works for the session when the vault's store has no name", async () => {
    // Obsidian's private `appId` gone: the library cannot name the store.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const setItem = vi.spyOn(storage, "setItem"),
      context = await start(() => {
        throw new Error("appId");
      });
    await expect(migrateProfileChoice(context)).resolves.toBeUndefined();
    expect(deviceDefaultProfile(context)?.[0]).toBe("zsh");
    expect(deviceProfileEntries(context).map(([id]) => id)).toEqual([
      "pwsh",
      "zsh",
      "bash",
    ]);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps the failed marker of a store that has no name", async () => {
    // The changelog check after this start skips a store that was not read,
    // or the changelog opens on every start.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const context = await start(() => {
      throw new Error("appId");
    });
    expect(StorageSettingsManager.hasFailed(context.localSettings.value)).toBe(
      true,
    );
    await migrateProfileChoice(context);
    expect(deviceDefaultProfile(context)?.[0]).toBe("zsh");
    expect(StorageSettingsManager.hasFailed(context.localSettings.value)).toBe(
      true,
    );
  });
});

describe("this device's default profile and order", () => {
  it("reads a store that 3.29.0 wrote as no choice, in the order of data.json", async () => {
    const { context } = await deviceContext(synced, released3290);
    expect(deviceDefaultProfileId(context)).toBeNull();
    expect(deviceDefaultProfile(context)).toBeNull();
    expect(deviceProfileEntries(context).map(([id]) => id)).toEqual([
      "pwsh",
      "zsh",
      "bash",
    ]);
  });

  it("lists the profiles in this device's order", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      profileOrder: ["bash", "gone", "pwsh"],
    });
    expect(deviceProfileEntries(context).map(([id]) => id)).toEqual([
      "bash",
      "pwsh",
      "zsh",
    ]);
  });

  it("opens this device's default, not the one in data.json", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "bash",
    });
    expect(deviceDefaultProfile(context)).toEqual([
      "bash",
      synced.profiles.bash,
    ]);
  });

  it("ignores a default profile deleted on another device", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "gone",
    });
    expect(deviceDefaultProfileId(context)).toBeNull();
    expect(deviceDefaultProfile(context)).toBeNull();
  });

  it("keeps a default that does not run here but does not open it", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "pwsh",
    });
    expect(deviceDefaultProfileId(context)).toBe("pwsh");
    expect(deviceDefaultProfile(context)).toBeNull();
  });

  it.each(["constructor", "__proto__", "toString"])(
    "never takes the inherited property %s for a default",
    async (id) => {
      const { context } = await deviceContext(synced, {
        ...released3290,
        defaultProfile: id,
      });
      expect(deviceDefaultProfileId(context)).toBeNull();
      expect(deviceDefaultProfile(context)).toBeNull();
    },
  );
});

describe("saving the profile list", () => {
  it("keeps a profile stored under the id __proto__ as a profile", async () => {
    const stored = JSON.parse(
        `{"a":${JSON.stringify(integrated)},"__proto__":${JSON.stringify(integrated)}}`,
      ) as unknown,
      { context, writeSettings } = await deviceContext(
        { profiles: stored },
        released3290,
      );
    expect(Object.keys(context.settings.value.profiles)).toEqual([
      "a",
      "__proto__",
    ]);
    const entries = deviceProfileEntries(context);
    await saveProfileList(context, {
      defaultProfile: null,
      entries: [...entries, ["b", { ...integrated, name: "b" }]],
    });
    expect(writeSettings).toHaveBeenCalledTimes(1);
    expect(Object.keys(context.settings.value.profiles)).toEqual([
      "a",
      "__proto__",
      "b",
    ]);
    expect(Object.getPrototypeOf(context.settings.value.profiles)).toBe(
      Object.prototype,
    );
    expect(
      Settings.fix(JSON.parse(JSON.stringify(context.settings.value))).valid,
    ).toBe(true);
  });

  it("saves this device's choice when data.json cannot be saved", async () => {
    const { context, writeSettings } = await deviceContext(synced, {
        ...released3290,
        defaultProfile: "zsh",
      }),
      error = new Error("EACCES"),
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSettings.mockRejectedValue(error);
    const entries = deviceProfileEntries(context).filter(
      ([id]) => id !== "pwsh",
    );
    await expect(
      saveProfileList(context, {
        defaultProfile: "bash" as Settings.DefaultProfile,
        entries: [...entries].reverse(),
      }),
    ).resolves.toBeUndefined();
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: "bash",
      profileOrder: ["bash", "zsh"],
    });
    expect(Object.keys(context.settings.value.profiles)).toEqual([
      "zsh",
      "bash",
    ]);
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(error);
    });
  });

  it("resets this device's choice when data.json cannot be saved", async () => {
    const { context, writeSettings } = await deviceContext(synced, {
        ...released3290,
        defaultProfile: "zsh",
        profileOrder: ["bash", "zsh", "pwsh"],
      }),
      error = new Error("EACCES"),
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSettings.mockRejectedValue(error);
    await expect(resetProfiles(context)).resolves.toBeUndefined();
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: null,
      profileOrder: [],
    });
    expect(context.settings.value.profiles).toEqual(Settings.DEFAULT.profiles);
    expect(context.settings.value.defaultProfile).toBeNull();
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(error);
    });
  });

  it("keeps the last of two edits that the list sends at once", async () => {
    const { context } = await deviceContext(synced, released3290),
      entries = deviceProfileEntries(context),
      fish = { ...integrated, name: "fish", platforms: { darwin: true } },
      renamed = entries.map(([id, profile]): Settings.Profile.Entry => [
        id,
        id === "zsh" ? { ...profile, name: "Z" } : profile,
      ]),
      added: Settings.Profile.Entry[] = [["fish", fish], ...renamed],
      // The list sends its whole state each time.
      first = {
        defaultProfile: "zsh" as Settings.DefaultProfile,
        entries: renamed,
      },
      second = {
        defaultProfile: "fish" as Settings.DefaultProfile,
        entries: added.reverse(),
      };
    await Promise.all([
      saveProfileList(context, first),
      saveProfileList(context, second),
    ]);
    expect(Object.keys(context.settings.value.profiles)).toEqual([
      "pwsh",
      "zsh",
      "bash",
      "fish",
    ]);
    expect(context.settings.value.profiles["zsh"]?.name).toBe("Z");
    expect(context.settings.value.defaultProfile).toBe("zsh");
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: "fish",
      profileOrder: ["bash", "zsh", "pwsh", "fish"],
    });
  });

  it("drops a profile deleted on another device from this device's order and default at the next save", async () => {
    const { context, writeSettings } = await deviceContext(
        { ...synced, defaultProfile: null },
        {
          ...released3290,
          defaultProfile: "gone",
          profileOrder: ["gone", "bash", "zsh", "pwsh"],
        },
      ),
      // As the settings tab opens the list.
      data = {
        defaultProfile: deviceDefaultProfileId(context),
        entries: deviceProfileEntries(context),
      };
    expect(data.defaultProfile).toBeNull();
    await saveProfileList(context, data);
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: null,
      profileOrder: ["bash", "zsh", "pwsh"],
    });
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it("keeps this device's order when a device on 3.29.0 reorders and adds profiles", async () => {
    const fish = { ...integrated, name: "fish", platforms: { darwin: true } },
      // data.json as a device on 3.29.0 saves it after a move and an addition.
      { context } = await deviceContext(
        {
          defaultProfile: "bash",
          profiles: {
            bash: synced.profiles.bash,
            fish,
            pwsh: synced.profiles.pwsh,
            zsh: synced.profiles.zsh,
          },
        },
        {
          ...released3290,
          defaultProfile: "zsh",
          profileOrder: ["zsh", "pwsh", "bash"],
        },
      );
    expect(deviceProfileEntries(context).map(([id]) => id)).toEqual([
      "zsh",
      "pwsh",
      "bash",
      "fish",
    ]);
    expect(deviceDefaultProfile(context)?.[0]).toBe("zsh");
  });
});
