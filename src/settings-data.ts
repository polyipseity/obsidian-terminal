import {
  type AnyObject,
  type Fixed,
  NOTICE_NO_TIMEOUT,
  NULL_SEM_VER_STRING,
  type Platform,
  PluginContext,
  type ReadonlyTuple,
  type SemVerString,
  type Unchecked,
  cloneAsWritable,
  deepFreeze,
  fixArray,
  fixInSet,
  fixTyped,
  inSet,
  isHomogenousArray,
  launderUnchecked,
  markFixed,
  opaqueOrDefault,
  semVerString,
} from "@polyipseity/obsidian-plugin-library";
import type {
  FontWeight,
  ILinkHandler,
  ILogger,
  ITerminalOptions,
  ITheme,
  IWindowOptions,
  IWindowsPty,
} from "@xterm/xterm";
import { isNil, isUndefined, omitBy } from "lodash-es";
import type {
  DeepReadonly,
  DeepRequired,
  DeepUndefinable,
  DeepWritable,
  MarkOptional,
} from "ts-essentials";
import { PluginLocales } from "../assets/locales.js";
import { DEFAULT_SUCCESS_EXIT_CODES } from "./magic.js";
import {
  RendererAddon,
  RightClickActionAddon,
} from "./terminal/emulator-addons.js";
import {
  DEFAULT_LINK_HANDLER,
  DEFAULT_LOGGER,
  DEFAULT_TERMINAL_OPTIONS,
  DEFAULT_THEME,
  DEFAULT_WINDOWS_PTY,
  DEFAULT_WINDOW_OPTIONS,
  PROFILE_PRESETS,
} from "./terminal/profile-presets.js";
import { Pseudoterminal } from "./terminal/pseudoterminal.js";

export interface LocalSettings extends PluginContext.LocalSettings {
  readonly lastReadChangelogVersion: SemVerString;
}
export namespace LocalSettings {
  export function fix(self0: unknown): Fixed<LocalSettings> {
    const unc = launderUnchecked<LocalSettings>(self0);
    return markFixed(self0, {
      ...PluginContext.LocalSettings.fix(self0).value,
      lastReadChangelogVersion: opaqueOrDefault(
        semVerString,
        String(unc.lastReadChangelogVersion),
        NULL_SEM_VER_STRING,
      ),
    });
  }
}

export interface Settings extends PluginContext.Settings {
  readonly language: Settings.DefaultableLanguage;
  readonly addToCommand: boolean;
  readonly addToContextMenu: boolean;
  readonly profiles: Settings.Profiles;
  readonly defaultProfile: Settings.DefaultProfile;

  // options applied to every terminal unless an individual profile overrides them
  readonly terminalOptions: Settings.Profile.TerminalOptions;

  readonly newInstanceBehavior: Settings.NewInstanceBehavior;
  readonly createInstanceNearExistingOnes: boolean;
  readonly focusOnNewInstance: boolean;
  readonly pinNewInstance: boolean;

  readonly openChangelogOnUpdate: boolean;
  readonly hideStatusBar: Settings.HideStatusBarOption;

  readonly exposeInternalModules: boolean;
  readonly interceptKeysWhenFocused: boolean;
  readonly interceptLogging: boolean;
  readonly macOSOptionKeyPassthrough: boolean;
  readonly preferredRenderer: Settings.PreferredRendererOption;
  readonly keymappings: readonly Settings.Keymapping[];
}
export namespace Settings {
  export type DefaultProfile = keyof Profiles | null;

  export const optionals = deepFreeze([]) satisfies readonly (keyof Settings)[];
  export type Optionals = (typeof optionals)[number];
  export type Persistent = Omit<Settings, Optionals>;
  export function persistent(settings: Settings): Persistent {
    const ret: MarkOptional<Settings, Optionals> = cloneAsWritable(settings);
    for (const optional of optionals) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete ret[optional];
    }
    return ret;
  }

  export const DEFAULT: Persistent = deepFreeze({
    addToCommand: true,
    addToContextMenu: true,
    createInstanceNearExistingOnes: true,
    errorNoticeTimeout: NOTICE_NO_TIMEOUT,
    exposeInternalModules: true,
    focusOnNewInstance: true,
    hideStatusBar: "focused",
    interceptKeysWhenFocused: true,
    interceptLogging: true,
    keymappings: [
      // Shift+Enter → ESC CR — all platforms.
      // Many TUI apps (e.g., Claude Code) distinguish Shift+Enter from plain
      // Enter; this sends the standard "modified CR" sequence ESC \r (\x1b\r).
      // Remove or override this entry if you need a different behaviour.
      {
        action: "sendEscapeSequence",
        actionArg: "\r",
        alt: false,
        ctrl: false,
        key: "Enter",
        meta: false,
        platform: null,
        shift: true,
      },
      // Page Up → scroll viewport one page up — all platforms.
      {
        action: "scrollPages",
        actionArg: -1,
        alt: false,
        ctrl: false,
        key: "PageUp",
        meta: false,
        platform: null,
        shift: false,
      },
      // Page Down → scroll viewport one page down — all platforms.
      {
        action: "scrollPages",
        actionArg: 1,
        alt: false,
        ctrl: false,
        key: "PageDown",
        meta: false,
        platform: null,
        shift: false,
      },
      // Home → scroll viewport to the top — all platforms.
      {
        action: "scrollToTop",
        actionArg: null,
        alt: false,
        ctrl: false,
        key: "Home",
        meta: false,
        platform: null,
        shift: false,
      },
      // End → scroll viewport to the bottom — all platforms.
      {
        action: "scrollToBottom",
        actionArg: null,
        alt: false,
        ctrl: false,
        key: "End",
        meta: false,
        platform: null,
        shift: false,
      },
      // Option+Left → word backward
      {
        action: "sendEscapeSequence",
        actionArg: "b",
        alt: true,
        ctrl: false,
        key: "ArrowLeft",
        meta: false,
        platform: "darwin",
        shift: false,
      },
      // Option+Right → word forward
      {
        action: "sendEscapeSequence",
        actionArg: "f",
        alt: true,
        ctrl: false,
        key: "ArrowRight",
        meta: false,
        platform: "darwin",
        shift: false,
      },
      // Cmd+Left → beginning of line (Ctrl+A)
      {
        action: "sendHexCode",
        actionArg: "01",
        alt: false,
        ctrl: false,
        key: "ArrowLeft",
        meta: true,
        platform: "darwin",
        shift: false,
      },
      // Cmd+Right → end of line (Ctrl+E)
      {
        action: "sendHexCode",
        actionArg: "05",
        alt: false,
        ctrl: false,
        key: "ArrowRight",
        meta: true,
        platform: "darwin",
        shift: false,
      },
      // Option+Backspace → delete word backward (Ctrl+W)
      {
        action: "sendHexCode",
        actionArg: "17",
        alt: true,
        ctrl: false,
        key: "Backspace",
        meta: false,
        platform: "darwin",
        shift: false,
      },
      // Cmd+Backspace → delete to beginning of line (Ctrl+U)
      {
        action: "sendHexCode",
        actionArg: "15",
        alt: false,
        ctrl: false,
        key: "Backspace",
        meta: true,
        platform: "darwin",
        shift: false,
      },
      // Option+Delete → delete word forward (ESC d)
      {
        action: "sendEscapeSequence",
        actionArg: "d",
        alt: true,
        ctrl: false,
        key: "Delete",
        meta: false,
        platform: "darwin",
        shift: false,
      },
    ],
    language: "",
    macOSOptionKeyPassthrough: true,
    newInstanceBehavior: "newHorizontalSplit",
    noticeTimeout: 5,
    openChangelogOnUpdate: true,
    pinNewInstance: true,
    preferredRenderer: "webgl",
    profiles: Object.fromEntries(
      (
        [
          "darwinExternalDefault",
          "darwinIntegratedDefault",
          "developerConsole",
          "linuxExternalDefault",
          "linuxIntegratedDefault",
          "win32ExternalDefault",
          "win32IntegratedDefault",
        ] satisfies readonly (keyof typeof PROFILE_PRESETS)[]
      ).map((key) => [key, PROFILE_PRESETS[key]]),
    ),
    defaultProfile: null,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
  });

  export const DEFAULTABLE_LANGUAGES = deepFreeze([
    "",
    ...PluginLocales.LANGUAGES,
  ]);
  export type DefaultableLanguage = (typeof DEFAULTABLE_LANGUAGES)[number];
  export const NEW_INSTANCE_BEHAVIORS = deepFreeze([
    "replaceTab",
    "newTab",
    "newLeftTab",
    "newLeftSplit",
    "newRightTab",
    "newRightSplit",
    "newHorizontalSplit",
    "newVerticalSplit",
    "newWindow",
  ]);
  export type NewInstanceBehavior = (typeof NEW_INSTANCE_BEHAVIORS)[number];

  export const HIDE_STATUS_BAR_OPTIONS = deepFreeze([
    "never",
    "always",
    "focused",
    "running",
  ]);
  export type HideStatusBarOption = (typeof HIDE_STATUS_BAR_OPTIONS)[number];

  export const PREFERRED_RENDERER_OPTIONS = RendererAddon.RENDERER_OPTIONS;
  export type PreferredRendererOption = RendererAddon.RendererOption;

  /**
   * All valid actions for a {@link Keymapping}.
   *
   * - `"ignore"` — suppress the event; send nothing.
   * - `"passthrough"` — yield to xterm.js; the event is processed as if no
   *   mapping matched. Useful for explicitly opting out of a default mapping
   *   for a specific key combination without deleting the default entry.
   * - `"scrollLines"` — scroll the terminal viewport by the number of lines
   *   given in {@link Keymapping.actionArg} (negative = up, positive = down).
   *   Defaults to 1 if the arg is absent or non-numeric.
   * - `"scrollPages"` — scroll the terminal viewport by the number of pages
   *   given in {@link Keymapping.actionArg} (negative = up, positive = down).
   *   Defaults to 1 if the arg is absent or non-numeric.
   * - `"scrollToBottom"` — scroll the terminal viewport to the bottom.
   * - `"scrollToTop"` — scroll the terminal viewport to the top.
   * - `"sendEscapeSequence"` — send `ESC` followed by {@link Keymapping.actionArg}.
   * - `"sendHexCode"` — send bytes specified as space-separated hex codes in
   *   {@link Keymapping.actionArg} (e.g., `"01 0d"`).
   * - `"sendText"` — send {@link Keymapping.actionArg} as-is, with `\\n`, `\\t`,
   *   `\\e`, and `\\a` interpreted as their control characters.
   */
  export const KEY_MAPPING_ACTIONS = deepFreeze([
    "ignore",
    "passthrough",
    "scrollLines",
    "scrollPages",
    "scrollToBottom",
    "scrollToTop",
    "sendEscapeSequence",
    "sendHexCode",
    "sendText",
  ] as const);
  export type KeymappingAction = (typeof KEY_MAPPING_ACTIONS)[number];

  /** Maps action types to their actionArg input type (or null if no arg needed). */
  export const ACTION_ARG_TYPES = deepFreeze({
    ignore: null,
    passthrough: null,
    scrollLines: "number",
    scrollPages: "number",
    scrollToBottom: null,
    scrollToTop: null,
    sendEscapeSequence: "string",
    sendHexCode: "string",
    sendText: "string",
  } as const satisfies Record<KeymappingAction, "number" | "string" | null>);
  export type ActionArgType = (typeof ACTION_ARG_TYPES)[KeymappingAction];

  export function isKeymappingAction(
    value: unknown,
  ): value is KeymappingAction {
    return inSet(KEY_MAPPING_ACTIONS, value);
  }
  export const KEY_MAPPING_PLATFORMS = [
    null,
    ...Pseudoterminal.SUPPORTED_PLATFORMS,
  ] as const;
  export type KeymappingPlatform = (typeof KEY_MAPPING_PLATFORMS)[number];
  export function isKeymappingPlatform(
    value: unknown,
  ): value is KeymappingPlatform {
    return inSet(KEY_MAPPING_PLATFORMS, value);
  }

  /** Represents a single keyboard mapping (singular). Collection of these is `keymappings`. */
  export type Keymapping = {
    readonly key: string;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly meta: boolean;
    readonly platform: KeymappingPlatform;
    readonly shift: boolean;
  } & (
    | {
        readonly action:
          | "ignore"
          | "passthrough"
          | "scrollToBottom"
          | "scrollToTop";
        readonly actionArg: null;
      }
    | {
        readonly action: "scrollLines" | "scrollPages";
        readonly actionArg: number;
      }
    | {
        readonly action: "sendEscapeSequence" | "sendHexCode" | "sendText";
        readonly actionArg: string;
      }
  );

  export namespace Keymapping {
    export const DEFAULT = deepFreeze({
      action: "ignore",
      actionArg: null,
      alt: false,
      ctrl: false,
      key: "",
      meta: false,
      platform: null,
      shift: false,
    }) satisfies Keymapping;

    export function isValidActionArg<
      const T extends (typeof ACTION_ARG_TYPES)[keyof typeof ACTION_ARG_TYPES],
    >(
      type: T,
      value: unknown,
    ): value is T extends null
      ? null
      : T extends "number"
        ? number
        : T extends "string"
          ? string
          : never {
      switch (type) {
        case null:
          return value === null;
        case "number":
          return typeof value === "number" && isFinite(value);
        case "string":
          return typeof value === "string";
      }
    }

    export function fix(self0: unknown): Fixed<Keymapping> {
      const unc = launderUnchecked<Keymapping>(self0);

      const action = fixInSet(DEFAULT, unc, "action", KEY_MAPPING_ACTIONS);
      const actionObject = (function () {
        switch (action) {
          case "ignore":
          case "passthrough":
          case "scrollToBottom":
          case "scrollToTop": {
            ACTION_ARG_TYPES[action] satisfies null; // Assert correct type for `actionArg`
            let actionArg = fixTyped(DEFAULT, unc, "actionArg", ["null"]);
            if (!isValidActionArg(ACTION_ARG_TYPES[action], actionArg)) {
              actionArg = null;
            }
            return { action, actionArg };
          }
          case "scrollLines":
          case "scrollPages": {
            ACTION_ARG_TYPES[action] satisfies "number"; // Assert correct type for `actionArg`
            let actionArg = fixTyped(DEFAULT, unc, "actionArg", ["number"]);
            if (!isValidActionArg(ACTION_ARG_TYPES[action], actionArg)) {
              actionArg = 1;
            }
            return { action, actionArg };
          }
          case "sendEscapeSequence":
          case "sendHexCode":
          case "sendText": {
            ACTION_ARG_TYPES[action] satisfies "string"; // Assert correct type for `actionArg`
            let actionArg = fixTyped(DEFAULT, unc, "actionArg", ["string"]);
            if (!isValidActionArg(ACTION_ARG_TYPES[action], actionArg)) {
              actionArg = "";
            }
            return { action, actionArg };
          }
        }
      })();

      return markFixed(self0, {
        ...actionObject,
        alt: fixTyped(DEFAULT, unc, "alt", ["boolean"]),
        ctrl: fixTyped(DEFAULT, unc, "ctrl", ["boolean"]),
        key: fixTyped(DEFAULT, unc, "key", ["string"]),
        meta: fixTyped(DEFAULT, unc, "meta", ["boolean"]),
        platform: fixInSet(DEFAULT, unc, "platform", KEY_MAPPING_PLATFORMS),
        shift: fixTyped(DEFAULT, unc, "shift", ["boolean"]),
      });
    }

    /**
     * Returns `true` when two mappings can conflict at runtime — that is,
     * when they share the same key combination AND their platform restrictions
     * overlap.
     *
     * Two entries with the same key combination but different, non-overlapping
     * platforms (e.g., one `"darwin"` and one `"linux"`) will never both fire
     * for the same event, so they do **not** conflict. An entry with
     * `platform: undefined` (all platforms) overlaps with every other entry.
     *
     * Use this instead of a plain key-equality check to avoid false positives
     * when detecting duplicates in the keymappings list.
     */
    export function conflictsKey(a: Keymapping, b: Keymapping): boolean {
      return (
        a.key === b.key &&
        a.ctrl === b.ctrl &&
        a.alt === b.alt &&
        a.meta === b.meta &&
        a.shift === b.shift &&
        // Platforms overlap when either entry is all-platform (null) or
        // both entries target the same specific platform.
        (a.platform === null ||
          b.platform === null ||
          a.platform === b.platform)
      );
    }
  }

  export type Profile =
    | Profile.DeveloperConsole
    | Profile.Empty
    | Profile.External
    | Profile.Integrated
    | Profile.Invalid;
  export type Profiles = Readonly<Record<string, Profile>>;
  export namespace Profile {
    export type Entry = readonly [key: string, value: Profile];
    export const TYPES = deepFreeze([
      "",
      "invalid",
      "developerConsole",
      "external",
      "integrated",
    ]);
    export type Type = (typeof TYPES)[number];
    export type Typed<T extends Type> = Profile & { readonly type: T };
    export function defaultOfType<T extends Type>(
      type: T,
      profiles: Profiles,
      platform?: Platform.All,
    ): Typed<T> | null {
      return defaultEntryOfType(type, profiles, platform)?.[1] ?? null;
    }
    export function defaultEntryOfType<T extends Type>(
      type: T,
      profiles: Profiles,
      platform?: Platform.All,
    ): readonly [string, Typed<T>] | null {
      for (const [key, profile] of Object.entries(profiles)) {
        if (
          isType(type, profile) &&
          (platform === void 0 || isCompatible(profile, platform))
        ) {
          return [key, profile];
        }
      }
      return null;
    }
    export function isCompatible(
      profile: Profile,
      platform: Platform.All,
    ): boolean {
      if (!("platforms" in profile)) {
        return true;
      }
      const platforms = launderUnchecked<AnyObject>(profile.platforms),
        supported = platforms[platform];
      if (typeof supported === "boolean" && supported) {
        return true;
      }
      return false;
    }
    export function isType<T extends Type>(
      type: T,
      profile: Profile,
    ): profile is Typed<T> {
      return profile.type === type;
    }
    export function name(profile: Profile): string {
      const { name: name0 } = profile;
      if (typeof name0 === "string") {
        return name0;
      }
      return "";
    }
    export function info([id, profile]: Entry): {
      readonly id: string;
      readonly name: string;
      readonly nameOrID: string;
      readonly profile: Profile;
    } {
      const name0 = name(profile);
      return Object.freeze({
        id,
        name: name0,
        nameOrID: name0 || id,
        profile,
      });
    }
    export type Platforms<T extends string> = Readonly<
      Partial<Record<T, boolean>>
    >;
    interface Base {
      readonly type: Type;
      readonly name: string;
      readonly followTheme: boolean;
      readonly restoreHistory: boolean;
      readonly rightClickAction: RightClickActionAddon.Action;
      readonly successExitCodes: readonly string[];
      readonly terminalOptions: TerminalOptions;
    }
    export interface Empty extends Base {
      readonly type: "";
    }
    export interface Invalid {
      readonly [_: string]: unknown;
      readonly type: "invalid";
    }
    export interface DeveloperConsole extends Base {
      readonly type: "developerConsole";
    }
    export interface External extends Base {
      readonly type: "external";
      readonly executable: string;
      readonly args: readonly string[];
      readonly platforms: Platforms<Pseudoterminal.SupportedPlatforms[number]>;
    }
    export interface Integrated extends Base {
      readonly type: "integrated";
      readonly executable: string;
      readonly args: readonly string[];
      readonly platforms: Platforms<Pseudoterminal.SupportedPlatforms[number]>;
      readonly pythonExecutable: string;
      readonly useWin32Conhost: boolean;
    }
    export const DEFAULTS: {
      readonly [key in Type]: DeepRequired<
        Omit<Typed<key>, "terminalOptions">
      > &
        Typed<key>;
    } = deepFreeze({
      "": PROFILE_PRESETS.empty,
      developerConsole: {
        followTheme: true,
        name: "",
        restoreHistory: false,
        rightClickAction: "copyPaste",
        successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
        terminalOptions: DEFAULT_TERMINAL_OPTIONS,
        type: "developerConsole",
      },
      external: {
        args: [],
        executable: "",
        followTheme: true,
        name: "",
        platforms: {
          darwin: false,
          linux: false,
          win32: false,
        },
        restoreHistory: false,
        rightClickAction: "copyPaste",
        successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
        terminalOptions: DEFAULT_TERMINAL_OPTIONS,
        type: "external",
      },
      integrated: {
        args: [],
        executable: "",
        followTheme: true,
        name: "",
        platforms: {
          darwin: false,
          linux: false,
          win32: false,
        },
        pythonExecutable: "",
        restoreHistory: false,
        rightClickAction: "copyPaste",
        successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
        terminalOptions: DEFAULT_TERMINAL_OPTIONS,
        type: "integrated",
        useWin32Conhost: true,
      },
      invalid: {
        type: "invalid",
      },
    });

    export function fix(self0: unknown): Fixed<Profile> {
      const unc = launderUnchecked<Invalid>(self0),
        fixPlatforms = <
          V extends Platforms<Vs[number]>,
          const Vs extends ReadonlyTuple<string>,
        >(
          defaults: V,
          from: Unchecked<V>,
          set: Vs,
        ): Platforms<Vs[number]> => {
          const ret2: Partial<Record<Vs[number], boolean>> = {};
          for (const platform0 of set) {
            const platform: Vs[number] = platform0;
            if (!(platform in from)) {
              continue;
            }
            const value = from[platform];
            ret2[platform] =
              typeof value === "boolean" ? value : defaults[platform];
          }
          return ret2;
        };

      return markFixed(
        self0,
        ((): DeepWritable<Profile> => {
          const type = inSet(TYPES, unc.type) ? unc.type : "invalid";
          switch (type) {
            case "": {
              return {
                followTheme: fixTyped(DEFAULTS[type], unc, "followTheme", [
                  "boolean",
                ]),
                name: fixTyped(DEFAULTS[type], unc, "name", ["string"]),
                restoreHistory: fixTyped(
                  DEFAULTS[type],
                  unc,
                  "restoreHistory",
                  ["boolean"],
                ),
                rightClickAction: fixInSet(
                  DEFAULTS[type],
                  unc,
                  "rightClickAction",
                  RightClickActionAddon.ACTIONS,
                ),
                successExitCodes: fixArray(
                  DEFAULTS[type],
                  unc,
                  "successExitCodes",
                  ["string"],
                ),
                terminalOptions: fixTerminalOptions(unc["terminalOptions"])
                  .value,
                type,
              } satisfies Typed<typeof type>;
            }
            case "developerConsole": {
              return {
                followTheme: fixTyped(DEFAULTS[type], unc, "followTheme", [
                  "boolean",
                ]),
                name: fixTyped(DEFAULTS[type], unc, "name", ["string"]),
                restoreHistory: fixTyped(
                  DEFAULTS[type],
                  unc,
                  "restoreHistory",
                  ["boolean"],
                ),
                rightClickAction: fixInSet(
                  DEFAULTS[type],
                  unc,
                  "rightClickAction",
                  RightClickActionAddon.ACTIONS,
                ),
                successExitCodes: fixArray(
                  DEFAULTS[type],
                  unc,
                  "successExitCodes",
                  ["string"],
                ),
                terminalOptions: fixTerminalOptions(unc["terminalOptions"])
                  .value,
                type,
              } satisfies Typed<typeof type>;
            }
            case "external": {
              return {
                args: fixArray(DEFAULTS[type], unc, "args", ["string"]),
                executable: fixTyped(DEFAULTS[type], unc, "executable", [
                  "string",
                ]),
                followTheme: fixTyped(DEFAULTS[type], unc, "followTheme", [
                  "boolean",
                ]),
                name: fixTyped(DEFAULTS[type], unc, "name", ["string"]),
                platforms: fixPlatforms(
                  DEFAULTS[type].platforms,
                  unc["platforms"] ?? {},
                  Pseudoterminal.SUPPORTED_PLATFORMS,
                ),
                restoreHistory: fixTyped(
                  DEFAULTS[type],
                  unc,
                  "restoreHistory",
                  ["boolean"],
                ),
                rightClickAction: fixInSet(
                  DEFAULTS[type],
                  unc,
                  "rightClickAction",
                  RightClickActionAddon.ACTIONS,
                ),
                successExitCodes: fixArray(
                  DEFAULTS[type],
                  unc,
                  "successExitCodes",
                  ["string"],
                ),
                terminalOptions: fixTerminalOptions(unc["terminalOptions"])
                  .value,
                type,
              } satisfies Typed<typeof type>;
            }
            case "integrated": {
              return {
                args: fixArray(DEFAULTS[type], unc, "args", ["string"]),
                executable: fixTyped(DEFAULTS[type], unc, "executable", [
                  "string",
                ]),
                followTheme: fixTyped(DEFAULTS[type], unc, "followTheme", [
                  "boolean",
                ]),
                name: fixTyped(DEFAULTS[type], unc, "name", ["string"]),
                platforms: fixPlatforms(
                  DEFAULTS[type].platforms,
                  unc["platforms"] ?? {},
                  Pseudoterminal.SUPPORTED_PLATFORMS,
                ),
                pythonExecutable: fixTyped(
                  DEFAULTS[type],
                  unc,
                  "pythonExecutable",
                  ["string"],
                ),
                restoreHistory: fixTyped(
                  DEFAULTS[type],
                  unc,
                  "restoreHistory",
                  ["boolean"],
                ),
                rightClickAction: fixInSet(
                  DEFAULTS[type],
                  unc,
                  "rightClickAction",
                  RightClickActionAddon.ACTIONS,
                ),
                successExitCodes: fixArray(
                  DEFAULTS[type],
                  unc,
                  "successExitCodes",
                  ["string"],
                ),
                terminalOptions: fixTerminalOptions(unc["terminalOptions"])
                  .value,
                type,
                useWin32Conhost: fixTyped(
                  DEFAULTS[type],
                  unc,
                  "useWin32Conhost",
                  ["boolean"],
                ),
              } satisfies Typed<typeof type>;
            }
            case "invalid": {
              return {
                ...unc,
                type,
              } satisfies Typed<typeof type>;
            }
            // No default
          }
        })(),
      );
    }

    export type TerminalOptions = Omit<
      DeepReadonly<ITerminalOptions>,
      "documentOverride"
    > & { readonly documentOverride: null };
    export namespace TerminalOptions {
      export const FONT_WEIGHTS = deepFreeze([
        "100",
        "200",
        "300",
        "400",
        "500",
        "600",
        "700",
        "800",
        "900",
        "bold",
        "normal",
      ]) satisfies readonly FontWeight[];
    }
    export function fixTerminalOptions(self0: unknown): Fixed<TerminalOptions> {
      const unc = launderUnchecked<TerminalOptions>(self0),
        ret2 = {
          allowProposedApi: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "allowProposedApi",
            ["undefined", "boolean"],
          ),
          allowTransparency: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "allowTransparency",
            ["undefined", "boolean"],
          ),
          altClickMovesCursor: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "altClickMovesCursor",
            ["undefined", "boolean"],
          ),
          convertEol: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "convertEol", [
            "undefined",
            "boolean",
          ]),
          cursorBlink: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "cursorBlink", [
            "undefined",
            "boolean",
          ]),
          cursorInactiveStyle: fixInSet(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "cursorInactiveStyle",
            [void 0, "bar", "block", "none", "outline", "underline"],
          ),
          cursorStyle: fixInSet(DEFAULT_TERMINAL_OPTIONS, unc, "cursorStyle", [
            void 0,
            "bar",
            "block",
            "underline",
          ]),
          cursorWidth: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "cursorWidth", [
            "undefined",
            "number",
          ]),
          customGlyphs: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "customGlyphs",
            ["undefined", "boolean"],
          ),
          disableStdin: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "disableStdin",
            ["undefined", "boolean"],
          ),
          // Do not expose `documentOverride`
          documentOverride: void 0,
          drawBoldTextInBrightColors: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "drawBoldTextInBrightColors",
            ["undefined", "boolean"],
          ),
          fastScrollModifier: fixInSet(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "fastScrollModifier",
            [void 0, "alt", "ctrl", "none", "shift"],
          ),
          fastScrollSensitivity: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "fastScrollSensitivity",
            ["undefined", "number"],
          ),
          fontFamily: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "fontFamily", [
            "undefined",
            "string",
          ]),
          fontSize: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "fontSize", [
            "undefined",
            "number",
          ]),
          fontWeight: ((): FontWeight | undefined => {
            const ret = fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "fontWeight", [
              "undefined",
              "number",
              "string",
            ]);
            return typeof ret === "string"
              ? fixInSet(
                  DEFAULT_TERMINAL_OPTIONS,
                  unc,
                  "fontWeight",
                  TerminalOptions.FONT_WEIGHTS,
                )
              : ret;
          })(),
          fontWeightBold: ((): FontWeight | undefined => {
            const ret = fixTyped(
              DEFAULT_TERMINAL_OPTIONS,
              unc,
              "fontWeightBold",
              ["undefined", "number", "string"],
            );
            return typeof ret === "string"
              ? fixInSet(
                  DEFAULT_TERMINAL_OPTIONS,
                  unc,
                  "fontWeightBold",
                  TerminalOptions.FONT_WEIGHTS,
                )
              : ret;
          })(),
          ignoreBracketedPasteMode: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "ignoreBracketedPasteMode",
            ["undefined", "boolean"],
          ),
          letterSpacing: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "letterSpacing",
            ["undefined", "number"],
          ),
          lineHeight: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "lineHeight", [
            "undefined",
            "number",
          ]),
          linkHandler:
            unc.linkHandler === void 0
              ? unc.linkHandler
              : ((): ILinkHandler => {
                  const unc2 = launderUnchecked<ILinkHandler>(unc.linkHandler),
                    ret = {
                      activate: fixTyped(
                        DEFAULT_LINK_HANDLER,
                        unc2,
                        "activate",
                        ["function"],
                      ) as ILinkHandler["activate"],
                      allowNonHttpProtocols: fixTyped(
                        DEFAULT_LINK_HANDLER,
                        unc2,
                        "allowNonHttpProtocols",
                        ["undefined", "boolean"],
                      ),

                      hover: fixTyped(DEFAULT_LINK_HANDLER, unc2, "hover", [
                        "undefined",
                        "function",
                      ]) as ILinkHandler["hover"],

                      leave: fixTyped(DEFAULT_LINK_HANDLER, unc2, "leave", [
                        "undefined",
                        "function",
                      ]) as ILinkHandler["leave"],
                    } satisfies Required<DeepUndefinable<ILinkHandler>>;
                  return {
                    ...omitBy(ret, isUndefined),
                    activate: ret.activate,
                  };
                })(),
          logLevel: fixInSet(DEFAULT_TERMINAL_OPTIONS, unc, "logLevel", [
            void 0,
            "debug",
            "error",
            "info",
            "off",
            "warn",
          ]),
          logger:
            unc.logger === void 0
              ? unc.logger
              : ((): ILogger => {
                  const unc2 = launderUnchecked<ILogger>(unc.logger),
                    ret = {
                      debug: fixTyped(DEFAULT_LOGGER, unc2, "debug", [
                        "function",
                      ]) as ILogger["debug"],

                      error: fixTyped(DEFAULT_LOGGER, unc2, "error", [
                        "function",
                      ]) as ILogger["error"],

                      info: fixTyped(DEFAULT_LOGGER, unc2, "info", [
                        "function",
                      ]) as ILogger["info"],

                      trace: fixTyped(DEFAULT_LOGGER, unc2, "trace", [
                        "function",
                      ]) as ILogger["trace"],

                      warn: fixTyped(DEFAULT_LOGGER, unc2, "warn", [
                        "function",
                      ]) as ILogger["warn"],
                    } satisfies Required<DeepUndefinable<ILogger>>;
                  return {
                    ...omitBy(ret, isUndefined),
                    debug: ret.debug,
                    error: ret.error,
                    info: ret.info,
                    trace: ret.trace,
                    warn: ret.warn,
                  };
                })(),
          macOptionClickForcesSelection: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "macOptionClickForcesSelection",
            ["undefined", "boolean"],
          ),
          macOptionIsMeta: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "macOptionIsMeta",
            ["undefined", "boolean"],
          ),
          minimumContrastRatio: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "minimumContrastRatio",
            ["undefined", "number"],
          ),
          overviewRulerWidth: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "overviewRulerWidth",
            ["undefined", "number"],
          ),
          rescaleOverlappingGlyphs: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "rescaleOverlappingGlyphs",
            ["undefined", "boolean"],
          ),
          rightClickSelectsWord: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "rightClickSelectsWord",
            ["undefined", "boolean"],
          ),
          screenReaderMode: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "screenReaderMode",
            ["undefined", "boolean"],
          ),
          scrollOnUserInput: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "scrollOnUserInput",
            ["undefined", "boolean"],
          ),
          scrollSensitivity: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "scrollSensitivity",
            ["undefined", "number"],
          ),
          scrollback: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "scrollback", [
            "undefined",
            "number",
          ]),
          smoothScrollDuration: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "smoothScrollDuration",
            ["undefined", "number"],
          ),
          tabStopWidth: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "tabStopWidth",
            ["undefined", "number"],
          ),
          theme:
            unc.theme === void 0
              ? unc.theme
              : ((): ITheme => {
                  const unc2 = launderUnchecked<ITheme>(unc.theme),
                    ret = {
                      background: fixTyped(DEFAULT_THEME, unc2, "background", [
                        "undefined",
                        "string",
                      ]),
                      black: fixTyped(DEFAULT_THEME, unc2, "black", [
                        "undefined",
                        "string",
                      ]),
                      blue: fixTyped(DEFAULT_THEME, unc2, "blue", [
                        "undefined",
                        "string",
                      ]),
                      brightBlack: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "brightBlack",
                        ["undefined", "string"],
                      ),
                      brightBlue: fixTyped(DEFAULT_THEME, unc2, "brightBlue", [
                        "undefined",
                        "string",
                      ]),
                      brightCyan: fixTyped(DEFAULT_THEME, unc2, "brightCyan", [
                        "undefined",
                        "string",
                      ]),
                      brightGreen: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "brightGreen",
                        ["undefined", "string"],
                      ),
                      brightMagenta: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "brightMagenta",
                        ["undefined", "string"],
                      ),
                      brightRed: fixTyped(DEFAULT_THEME, unc2, "brightRed", [
                        "undefined",
                        "string",
                      ]),
                      brightWhite: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "brightWhite",
                        ["undefined", "string"],
                      ),
                      brightYellow: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "brightYellow",
                        ["undefined", "string"],
                      ),
                      cursor: fixTyped(DEFAULT_THEME, unc2, "cursor", [
                        "undefined",
                        "string",
                      ]),
                      cursorAccent: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "cursorAccent",
                        ["undefined", "string"],
                      ),
                      cyan: fixTyped(DEFAULT_THEME, unc2, "cyan", [
                        "undefined",
                        "string",
                      ]),
                      extendedAnsi:
                        unc2.extendedAnsi === void 0 ||
                        isHomogenousArray(["string"], unc2.extendedAnsi)
                          ? unc2.extendedAnsi
                          : DEFAULT_THEME.extendedAnsi,
                      foreground: fixTyped(DEFAULT_THEME, unc2, "foreground", [
                        "undefined",
                        "string",
                      ]),
                      green: fixTyped(DEFAULT_THEME, unc2, "green", [
                        "undefined",
                        "string",
                      ]),
                      magenta: fixTyped(DEFAULT_THEME, unc2, "magenta", [
                        "undefined",
                        "string",
                      ]),
                      red: fixTyped(DEFAULT_THEME, unc2, "red", [
                        "undefined",
                        "string",
                      ]),
                      selectionBackground: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "selectionBackground",
                        ["undefined", "string"],
                      ),
                      selectionForeground: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "selectionForeground",
                        ["undefined", "string"],
                      ),
                      selectionInactiveBackground: fixTyped(
                        DEFAULT_THEME,
                        unc2,
                        "selectionInactiveBackground",
                        ["undefined", "string"],
                      ),
                      white: fixTyped(DEFAULT_THEME, unc2, "white", [
                        "undefined",
                        "string",
                      ]),
                      yellow: fixTyped(DEFAULT_THEME, unc2, "yellow", [
                        "undefined",
                        "string",
                      ]),
                    } satisfies Required<DeepUndefinable<ITheme>>;
                  return omitBy(ret, isUndefined);
                })(),
          windowOptions:
            unc.windowOptions === void 0
              ? unc.windowOptions
              : ((): IWindowOptions => {
                  const unc2 = launderUnchecked<IWindowOptions>(
                      unc.windowOptions,
                    ),
                    ret = {
                      fullscreenWin: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "fullscreenWin",
                        ["undefined", "boolean"],
                      ),
                      getCellSizePixels: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getCellSizePixels",
                        ["undefined", "boolean"],
                      ),
                      getIconTitle: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getIconTitle",
                        ["undefined", "boolean"],
                      ),
                      getScreenSizeChars: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getScreenSizeChars",
                        ["undefined", "boolean"],
                      ),
                      getScreenSizePixels: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getScreenSizePixels",
                        ["undefined", "boolean"],
                      ),
                      getWinPosition: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getWinPosition",
                        ["undefined", "boolean"],
                      ),
                      getWinSizeChars: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getWinSizeChars",
                        ["undefined", "boolean"],
                      ),
                      getWinSizePixels: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getWinSizePixels",
                        ["undefined", "boolean"],
                      ),
                      getWinState: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getWinState",
                        ["undefined", "boolean"],
                      ),
                      getWinTitle: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "getWinTitle",
                        ["undefined", "boolean"],
                      ),
                      lowerWin: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "lowerWin",
                        ["undefined", "boolean"],
                      ),
                      maximizeWin: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "maximizeWin",
                        ["undefined", "boolean"],
                      ),
                      minimizeWin: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "minimizeWin",
                        ["undefined", "boolean"],
                      ),
                      popTitle: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "popTitle",
                        ["undefined", "boolean"],
                      ),
                      pushTitle: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "pushTitle",
                        ["undefined", "boolean"],
                      ),
                      raiseWin: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "raiseWin",
                        ["undefined", "boolean"],
                      ),
                      refreshWin: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "refreshWin",
                        ["undefined", "boolean"],
                      ),
                      restoreWin: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "restoreWin",
                        ["undefined", "boolean"],
                      ),
                      setWinLines: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "setWinLines",
                        ["undefined", "boolean"],
                      ),
                      setWinPosition: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "setWinPosition",
                        ["undefined", "boolean"],
                      ),
                      setWinSizeChars: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "setWinSizeChars",
                        ["undefined", "boolean"],
                      ),
                      setWinSizePixels: fixTyped(
                        DEFAULT_WINDOW_OPTIONS,
                        unc2,
                        "setWinSizePixels",
                        ["undefined", "boolean"],
                      ),
                    } satisfies Required<DeepUndefinable<IWindowOptions>>;
                  return omitBy(ret, isUndefined);
                })(),
          windowsMode: fixTyped(DEFAULT_TERMINAL_OPTIONS, unc, "windowsMode", [
            "undefined",
            "boolean",
          ]),
          windowsPty:
            unc.windowsPty === void 0
              ? unc.windowsPty
              : ((): IWindowsPty => {
                  const unc2 = launderUnchecked<IWindowsPty>(unc.windowsPty),
                    ret = {
                      backend: fixInSet(DEFAULT_WINDOWS_PTY, unc2, "backend", [
                        void 0,
                        "conpty",
                        "winpty",
                      ]),
                      buildNumber: fixTyped(
                        DEFAULT_WINDOWS_PTY,
                        unc2,
                        "buildNumber",
                        ["undefined", "number"],
                      ),
                    } satisfies Required<DeepUndefinable<IWindowsPty>>;
                  return omitBy(ret, isUndefined);
                })(),
          wordSeparator: fixTyped(
            DEFAULT_TERMINAL_OPTIONS,
            unc,
            "wordSeparator",
            ["undefined", "string"],
          ),
        } satisfies Required<DeepUndefinable<TerminalOptions>>;
      return markFixed(self0, {
        ...omitBy(ret2, isUndefined),
        documentOverride: DEFAULT_TERMINAL_OPTIONS.documentOverride,
      });
    }
  }
  export function fix(self0: unknown): Fixed<Settings> {
    const unc = launderUnchecked<Settings>(self0);

    // prepare profiles ahead of the main fixed object so defaultProfile
    // validation can reference the fixed set.
    const fixedProfiles: DeepWritable<Profiles> = (() => {
      const defaults2 = DEFAULT.profiles,
        { profiles } = unc;
      if (typeof profiles === "object" && profiles) {
        return Object.fromEntries(
          Object.entries(profiles).map(([id, profile]) => [
            id,
            Profile.fix(profile).value,
          ]),
        );
      }
      return cloneAsWritable(defaults2);
    })();

    const fixed = {
      ...PluginContext.Settings.fix(self0).value,
      addToCommand: fixTyped(DEFAULT, unc, "addToCommand", ["boolean"]),
      addToContextMenu: fixTyped(DEFAULT, unc, "addToContextMenu", ["boolean"]),
      createInstanceNearExistingOnes: fixTyped(
        DEFAULT,
        unc,
        "createInstanceNearExistingOnes",
        ["boolean"],
      ),
      errorNoticeTimeout: fixTyped(DEFAULT, unc, "errorNoticeTimeout", [
        "number",
      ]),
      exposeInternalModules: fixTyped(DEFAULT, unc, "exposeInternalModules", [
        "boolean",
      ]),
      focusOnNewInstance: fixTyped(DEFAULT, unc, "focusOnNewInstance", [
        "boolean",
      ]),
      hideStatusBar: fixInSet(
        DEFAULT,
        unc,
        "hideStatusBar",
        HIDE_STATUS_BAR_OPTIONS,
      ),
      interceptKeysWhenFocused: fixTyped(
        DEFAULT,
        unc,
        "interceptKeysWhenFocused",
        ["boolean"],
      ),
      interceptLogging: fixTyped(DEFAULT, unc, "interceptLogging", ["boolean"]),
      keymappings: (() => {
        const { keymappings } = unc;
        if (Array.isArray(keymappings)) {
          return keymappings.map((m: unknown) => Keymapping.fix(m).value);
        }
        return cloneAsWritable(DEFAULT.keymappings);
      })(),
      language: fixInSet(DEFAULT, unc, "language", DEFAULTABLE_LANGUAGES),
      macOSOptionKeyPassthrough: fixTyped(
        DEFAULT,
        unc,
        "macOSOptionKeyPassthrough",
        ["boolean"],
      ),
      newInstanceBehavior: fixInSet(
        DEFAULT,
        unc,
        "newInstanceBehavior",
        NEW_INSTANCE_BEHAVIORS,
      ),
      noticeTimeout: fixTyped(DEFAULT, unc, "noticeTimeout", ["number"]),
      openChangelogOnUpdate: fixTyped(DEFAULT, unc, "openChangelogOnUpdate", [
        "boolean",
      ]),
      pinNewInstance: fixTyped(DEFAULT, unc, "pinNewInstance", ["boolean"]),
      preferredRenderer: fixInSet(
        DEFAULT,
        unc,
        "preferredRenderer",
        PREFERRED_RENDERER_OPTIONS,
      ),
      profiles: fixedProfiles,
      // defaultProfile will be validated against fixedProfiles
      defaultProfile: ((): Settings.DefaultProfile => {
        const raw = unc.defaultProfile;
        if (isNil(raw)) {
          return null;
        }
        const rp = String(raw);
        if (rp && fixedProfiles[rp] !== undefined) {
          return rp as Settings.DefaultProfile;
        }
        return null;
      })(),
      terminalOptions: Settings.Profile.fixTerminalOptions(
        unc["terminalOptions"],
      ).value,
    };
    return markFixed(self0, fixed);
  }
}
