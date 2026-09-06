import {
  DEFAULT_PYTHON_EXECUTABLE,
  DEFAULT_SUCCESS_EXIT_CODES,
  WINDOWS_CMD_PATH,
} from "../magic.js";
import type {
  ILinkHandler,
  ILogger,
  IOverviewRulerOptions,
  ITheme,
  IWindowOptions,
  IWindowsPty,
} from "@xterm/xterm";
import {
  activeSelf,
  deepFreeze,
  openExternal,
  typedKeys,
} from "@polyipseity/obsidian-plugin-library";
import type { Pseudoterminal } from "./pseudoterminal.js";
import type { Settings } from "../settings-data.js";

export const DEFAULT_LINK_HANDLER: ILinkHandler = deepFreeze({
    activate(event, text, _range) {
      openExternal(activeSelf(event), text);
    },
  }),
  DEFAULT_LOGGER: ILogger = deepFreeze({
    debug(message, ...args: readonly unknown[]) {
      self.console.debug(message, ...args);
    },
    error(message, ...args: readonly unknown[]) {
      self.console.error(message, ...args);
    },
    info(message, ...args: readonly unknown[]) {
      self.console.info(message, ...args);
    },
    trace(message, ...args: readonly unknown[]) {
      self.console.trace(message, ...args);
    },
    warn(message, ...args: readonly unknown[]) {
      self.console.warn(message, ...args);
    },
  }),
  DEFAULT_OVERVIEW_RULER_OPTIONS: IOverviewRulerOptions = deepFreeze({}),
  DEFAULT_TERMINAL_OPTIONS: Settings.Profile.TerminalOptions = deepFreeze({
    documentOverride: null,
  }),
  DEFAULT_THEME: ITheme = deepFreeze({}),
  DEFAULT_WINDOW_OPTIONS: IWindowOptions = deepFreeze({}),
  DEFAULT_WINDOWS_PTY: IWindowsPty = deepFreeze({});

export interface ProfilePresets0 {
  readonly empty: Settings.Profile.Empty;
  readonly developerConsole: Settings.Profile.DeveloperConsole;

  readonly cmdExternal: Settings.Profile.External;
  readonly gnomeTerminalExternal: Settings.Profile.External;
  readonly iTerm2External: Settings.Profile.External;
  readonly konsoleExternal: Settings.Profile.External;
  readonly powershellExternal: Settings.Profile.External;
  readonly pwshExternal: Settings.Profile.External;
  readonly terminalMacOSExternal: Settings.Profile.External;
  readonly wtExternal: Settings.Profile.External;
  readonly xtermExternal: Settings.Profile.External;

  readonly bashIntegrated: Settings.Profile.Integrated;
  readonly cmdIntegrated: Settings.Profile.Integrated;
  readonly dashIntegrated: Settings.Profile.Integrated;
  readonly gitBashIntegrated: Settings.Profile.Integrated;
  readonly powershellIntegrated: Settings.Profile.Integrated;
  readonly pwshIntegrated: Settings.Profile.Integrated;
  readonly shIntegrated: Settings.Profile.Integrated;
  readonly wslIntegrated: Settings.Profile.Integrated;
  readonly zshIntegrated: Settings.Profile.Integrated;
}
type ExternalDefaults = Readonly<
  Record<
    `${Pseudoterminal.SupportedPlatforms[number]}ExternalDefault`,
    Settings.Profile.External
  >
>;
type IntegratedDefaults = Readonly<
  Record<
    `${Pseudoterminal.SupportedPlatforms[number]}IntegratedDefault`,
    Settings.Profile.Integrated
  >
>;
export interface ProfilePresets
  extends ProfilePresets0, ExternalDefaults, IntegratedDefaults {}
const PROFILE_PRESETS0 = deepFreeze({
  bashIntegrated: {
    args: ["--login"],
    environment: [],
    executable: "/bin/bash",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true },
    pythonExecutable: DEFAULT_PYTHON_EXECUTABLE,
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  cmdExternal: {
    args: [],
    environment: [],
    executable: WINDOWS_CMD_PATH,
    followTheme: true,
    name: "",
    platforms: { win32: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  cmdIntegrated: {
    args: [],
    environment: [],
    executable: WINDOWS_CMD_PATH,
    followTheme: true,
    name: "",
    platforms: { win32: true },
    pythonExecutable: "",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  dashIntegrated: {
    args: [],
    environment: [],
    executable: "/bin/dash",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true },
    pythonExecutable: DEFAULT_PYTHON_EXECUTABLE,
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  developerConsole: {
    followTheme: true,
    name: "",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "developerConsole",
  },
  empty: {
    followTheme: true,
    name: "",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "",
  },
  gitBashIntegrated: {
    args: ["--login"],
    environment: [],
    executable: "C:\\Program Files\\Git\\bin\\bash.exe",
    followTheme: true,
    name: "",
    platforms: { win32: true },
    pythonExecutable: "",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  gnomeTerminalExternal: {
    args: [],
    environment: [],
    executable: "gnome-terminal",
    followTheme: true,
    name: "",
    platforms: { linux: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  iTerm2External: {
    args: ['"$PWD"'],
    environment: [],
    executable: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
    followTheme: true,
    name: "",
    platforms: { darwin: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  konsoleExternal: {
    args: [],
    environment: [],
    executable: "konsole",
    followTheme: true,
    name: "",
    platforms: { linux: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  powershellExternal: {
    args: [],
    environment: [],
    executable: "powershell",
    followTheme: true,
    name: "",
    platforms: { win32: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  powershellIntegrated: {
    args: [],
    environment: [],
    executable: "powershell",
    followTheme: true,
    name: "",
    platforms: { win32: true },
    pythonExecutable: "",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  pwshExternal: {
    args: [],
    environment: [],
    executable: "pwsh",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true, win32: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  pwshIntegrated: {
    args: [],
    environment: [],
    executable: "pwsh",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true, win32: true },
    pythonExecutable: DEFAULT_PYTHON_EXECUTABLE,
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  shIntegrated: {
    args: [],
    environment: [],
    executable: "/bin/sh",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true },
    pythonExecutable: DEFAULT_PYTHON_EXECUTABLE,
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  terminalMacOSExternal: {
    args: ['"$PWD"'],
    environment: [],
    executable:
      "/System/Applications/Utilities/Terminal.app/Contents/macOS/Terminal",
    followTheme: true,
    name: "",
    platforms: { darwin: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  wslIntegrated: {
    args: [],
    environment: [],
    executable: "C:\\Windows\\System32\\wsl.exe",
    followTheme: true,
    name: "",
    platforms: { win32: true },
    pythonExecutable: "",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
  wtExternal: {
    args: [],
    environment: [],
    executable: "wt",
    followTheme: true,
    name: "",
    platforms: { win32: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  xtermExternal: {
    args: [],
    environment: [],
    executable: "xterm",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true },
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "external",
  },
  zshIntegrated: {
    args: ["--login"],
    environment: [],
    executable: "/bin/zsh",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true },
    pythonExecutable: DEFAULT_PYTHON_EXECUTABLE,
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
    terminalOptions: DEFAULT_TERMINAL_OPTIONS,
    type: "integrated",
    win32Backend: "conpty",
    win32BackendAutoDemoted: false,
  },
}) satisfies ProfilePresets0;
export const PROFILE_PRESETS = deepFreeze({
  ...PROFILE_PRESETS0,
  darwinExternalDefault: {
    ...PROFILE_PRESETS0.terminalMacOSExternal,
    platforms: { darwin: true },
  },
  darwinIntegratedDefault: {
    ...PROFILE_PRESETS0.zshIntegrated,
    platforms: { darwin: true },
  },
  linuxExternalDefault: {
    ...PROFILE_PRESETS0.xtermExternal,
    platforms: { linux: true },
  },
  linuxIntegratedDefault: {
    ...PROFILE_PRESETS0.shIntegrated,
    platforms: { linux: true },
  },
  win32ExternalDefault: {
    ...PROFILE_PRESETS0.cmdExternal,
    platforms: { win32: true },
  },
  win32IntegratedDefault: {
    ...PROFILE_PRESETS0.cmdIntegrated,
    platforms: { win32: true },
  },
}) satisfies ProfilePresets;
export type ProfilePresetKeys = readonly [
  "empty",
  "developerConsole",

  "cmdExternal",
  "gnomeTerminalExternal",
  "iTerm2External",
  "konsoleExternal",
  "powershellExternal",
  "pwshExternal",
  "terminalMacOSExternal",
  "wtExternal",
  "xtermExternal",

  "bashIntegrated",
  "cmdIntegrated",
  "dashIntegrated",
  "gitBashIntegrated",
  "powershellIntegrated",
  "pwshIntegrated",
  "shIntegrated",
  "wslIntegrated",
  "zshIntegrated",

  "darwinExternalDefault",
  "linuxExternalDefault",
  "win32ExternalDefault",

  "darwinIntegratedDefault",
  "linuxIntegratedDefault",
  "win32IntegratedDefault",
];
export const PROFILE_PRESET_KEYS =
  typedKeys<ProfilePresetKeys>()(PROFILE_PRESETS);
export const PROFILE_PRESET_ORDERED_KEYS = deepFreeze(
  PROFILE_PRESET_KEYS.reduce<ProfilePresetKeys[number][]>((prev, cur) => {
    if (cur === "empty") {
      prev.unshift(cur);
    } else {
      prev.push(cur);
    }
    return prev;
  }, []),
);
