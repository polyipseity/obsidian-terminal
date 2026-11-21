/**
 * The default profile and the order of the profiles belong to each device and
 * live in its local settings. The profiles themselves sync in `data.json`,
 * which keeps the shape that 3.29.0 reads: its `defaultProfile` is no longer
 * set here, only cleared when its profile goes.
 */
import {
  Platform,
  cloneAsWritable,
} from "@polyipseity/obsidian-plugin-library";
import { isEqual } from "es-toolkit/predicate";
import type { TerminalPlugin } from "./main.js";
import type { ProfileListModal } from "./modals.js";
import { Settings } from "./settings-data.js";

type Context = Pick<TerminalPlugin, "localSettings" | "settings">;

/** The profiles in this device's order. */
export function deviceProfileEntries(
  context: Context,
): Settings.Profile.Entry[] {
  return Settings.Profile.orderedEntries(
    context.settings.value.profiles,
    context.localSettings.value.profileOrder ?? [],
  );
}

/** This device's default profile id while that profile exists, else `null`. */
export function deviceDefaultProfileId(
  context: Context,
): Settings.DefaultProfile {
  const id = context.localSettings.value.defaultProfile ?? null;
  return id !== null &&
    Settings.Profile.byId(context.settings.value.profiles, id)
    ? id
    : null;
}

/** The profile stored under `id` while it runs on this platform, else `null`. */
export function runnableProfile(
  profiles: Settings.Profiles,
  id: string | null,
): readonly [string, Settings.Profile] | null {
  if (id === null) {
    return null;
  }
  const profile = Settings.Profile.byId(profiles, id);
  return profile && Settings.Profile.isCompatible(profile, Platform.CURRENT)
    ? [id, profile]
    : null;
}

/** This device's default profile while it exists and runs on this platform. */
export function deviceDefaultProfile(
  context: Context,
): readonly [string, Settings.Profile] | null {
  return runnableProfile(
    context.settings.value.profiles,
    context.localSettings.value.defaultProfile ?? null,
  );
}

/**
 * At the first start of this version, takes over what the device used on
 * 3.29.0: the default from `data.json` if that profile runs here, and the order
 * of `data.json`. A new or cleared store already has both keys and stays as it
 * is, so it starts without a default.
 */
export async function migrateProfileChoice(context: Context): Promise<void> {
  const { localSettings, settings } = context,
    takeDefault = !Object.hasOwn(localSettings.value, "defaultProfile"),
    takeOrder = !Object.hasOwn(localSettings.value, "profileOrder");
  if (!takeDefault && !takeOrder) {
    return;
  }
  const { defaultProfile, profiles } = settings.value;
  try {
    await localSettings.mutate((localM) => {
      if (takeDefault) {
        localM.defaultProfile = runnableProfile(profiles, defaultProfile)
          ? defaultProfile
          : null;
      }
      if (takeOrder) {
        localM.profileOrder = Object.keys(profiles);
      }
    });
    await localSettings.write();
  } catch (error) {
    // Unsaved, the choice holds for this session and is taken over again.
    self.console.error(error);
  }
}

/**
 * Stores an edit from the profile list. The order and the default go to this
 * device. In `data.json`, profiles keep their place, new ones go last, and its
 * default is cleared only when its profile was deleted; `data.json` is not
 * written when nothing in it changed, as after a move or a new default.
 */
export async function saveProfileList(
  context: Context,
  data: ProfileListModal.Data,
): Promise<void> {
  const { localSettings, settings } = context,
    { defaultProfile, profiles } = settings.value,
    listed = new Map(data.entries),
    nextProfiles = Object.fromEntries([
      ...Object.keys(profiles).flatMap((id) => {
        const profile = listed.get(id);
        return profile ? [[id, profile] as const] : [];
      }),
      ...data.entries.filter(([id]) => !Object.hasOwn(profiles, id)),
    ]),
    nextDefault =
      defaultProfile !== null && !listed.has(defaultProfile)
        ? null
        : defaultProfile;
  if (nextDefault !== defaultProfile || !isEqual(nextProfiles, profiles)) {
    await settings.mutate((settingsM) => {
      settingsM.profiles = cloneAsWritable(nextProfiles);
      settingsM.defaultProfile = nextDefault;
    });
    settings.write().catch((error: unknown) => {
      self.console.error(error);
    });
  }
  await localSettings.mutate((localM) => {
    localM.profileOrder = [...listed.keys()];
    // The list keeps sending the default it was opened with, even after
    // deleting that profile.
    localM.defaultProfile =
      data.defaultProfile !== null && listed.has(data.defaultProfile)
        ? data.defaultProfile
        : null;
  });
}

/**
 * Reset of the profiles: the presets in `data.json`, this device's order
 * cleared, and each default cleared when its profile is gone.
 */
export async function resetProfiles(context: Context): Promise<void> {
  const { localSettings, settings } = context;
  await settings.mutate((settingsM) => {
    settingsM.profiles = cloneAsWritable(Settings.DEFAULT.profiles);
    const { defaultProfile } = settingsM;
    if (
      defaultProfile !== null &&
      !Object.hasOwn(settingsM.profiles, defaultProfile)
    ) {
      settingsM.defaultProfile = null;
    }
  });
  settings.write().catch((error: unknown) => {
    self.console.error(error);
  });
  // This device's default, if Reset brought its profile back.
  const kept = deviceDefaultProfileId(context);
  await localSettings.mutate((localM) => {
    localM.profileOrder = [];
    localM.defaultProfile = kept;
  });
}
