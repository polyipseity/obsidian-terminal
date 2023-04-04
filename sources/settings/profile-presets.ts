import { deepFreeze, typedKeys } from "sources/utils/util"
import type { Pseudoterminal } from "sources/terminal/pseudoterminal"
import type { Settings } from "./data"
import { WINDOWS_CMD_PATH } from "sources/magic"

export interface ProfilePresets0 {
	readonly empty: Settings.Profile.Empty
	readonly developerConsole: Settings.Profile.DeveloperConsole

	readonly cmdExternal: Settings.Profile.External
	readonly gnomeTerminalExternal: Settings.Profile.External
	readonly konsoleExternal: Settings.Profile.External
	readonly terminalMacOSExternal: Settings.Profile.External
	readonly wtExternal: Settings.Profile.External
	readonly xtermExternal: Settings.Profile.External

	readonly bashIntegrated: Settings.Profile.Integrated
	readonly cmdIntegrated: Settings.Profile.Integrated
	readonly dashIntegrated: Settings.Profile.Integrated
	readonly gitBashIntegrated: Settings.Profile.Integrated
	readonly pwshIntegrated: Settings.Profile.Integrated
	readonly shIntegrated: Settings.Profile.Integrated
	readonly wslIntegrated: Settings.Profile.Integrated
	readonly zshIntegrated: Settings.Profile.Integrated
}
type ExternalDefaults = {
	readonly [_ in `${Pseudoterminal.SupportedPlatforms[number]
	}ExternalDefault`]: Settings.Profile.External
}
type IntegratedDefaults = {
	readonly [_ in `${Pseudoterminal.SupportedPlatforms[number]
	}IntegratedDefault`]: Settings.Profile.Integrated
}
export interface ProfilePresets
	extends ProfilePresets0, ExternalDefaults, IntegratedDefaults { }
const PROFILE_PRESETS0 = deepFreeze({
	bashIntegrated: {
		args: [],
		executable: "/bin/bash",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
	cmdExternal: {
		args: [],
		executable: WINDOWS_CMD_PATH,
		name: "",
		platforms: { win32: true },
		restoreHistory: true,
		type: "external",
	},
	cmdIntegrated: {
		args: [],
		executable: WINDOWS_CMD_PATH,
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
	dashIntegrated: {
		args: [],
		executable: "/bin/dash",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
	developerConsole: {
		name: "",
		restoreHistory: true,
		type: "developerConsole",
	},
	empty: {
		name: "",
		restoreHistory: true,
		type: "",
	},
	gitBashIntegrated: {
		args: [],
		executable: "C:\\Program Files\\Git\\bin\\bash.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
	gnomeTerminalExternal: {
		args: [],
		executable: "gnome-terminal",
		name: "",
		platforms: { linux: true },
		restoreHistory: true,
		type: "external",
	},
	konsoleExternal: {
		args: [],
		executable: "konsole",
		name: "",
		platforms: { linux: true },
		restoreHistory: true,
		type: "external",
	},
	pwshIntegrated: {
		args: [],
		executable: "pwsh",
		name: "",
		platforms: { darwin: true, linux: true, win32: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
	shIntegrated: {
		args: [],
		executable: "/bin/sh",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
	terminalMacOSExternal: {
		args: [],
		executable:
			"/System/Applications/Utilities/Terminal.app/Contents/macOS/Terminal",
		name: "",
		platforms: { darwin: true },
		restoreHistory: true,
		type: "external",
	},
	wslIntegrated: {
		args: [],
		executable: "C:\\Windows\\System32\\wsl.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
	wtExternal: {
		args: [],
		executable: "wt",
		name: "",
		platforms: { win32: true },
		restoreHistory: true,
		type: "external",
	},
	xtermExternal: {
		args: [],
		executable: "xterm",
		name: "",
		platforms: { darwin: true, linux: true },
		restoreHistory: true,
		type: "external",
	},
	zshIntegrated: {
		args: [],
		executable: "/bin/zsh",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		restoreHistory: true,
		type: "integrated",
		useWin32Conhost: true,
	},
} as const satisfies ProfilePresets0)
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
} as const satisfies ProfilePresets)
export type ProfilePresetKeys = readonly [
	"empty",
	"developerConsole",

	"cmdExternal",
	"gnomeTerminalExternal",
	"konsoleExternal",
	"terminalMacOSExternal",
	"wtExternal",
	"xtermExternal",

	"bashIntegrated",
	"cmdIntegrated",
	"dashIntegrated",
	"gitBashIntegrated",
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
]
export const PROFILE_PRESET_KEYS =
	typedKeys<ProfilePresetKeys>()(PROFILE_PRESETS)
export const PROFILE_PRESET_ORDERED_KEYS =
	deepFreeze(PROFILE_PRESET_KEYS.reduce<ProfilePresetKeys[number][]
	>((prev, cur) => {
		if (cur === "empty") {
			prev.unshift(cur)
		} else {
			prev.push(cur)
		}
		return prev
	}, []))
