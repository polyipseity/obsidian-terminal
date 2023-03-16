import { TERMINAL_MACOS_PATH, WINDOWS_CMD_PATH } from "sources/magic"
import { deepFreeze, typedKeys } from "sources/utils/util"
import type { Pseudoterminal } from "sources/terminal/pseudoterminal"
import type { Settings } from "./data"

type ExternalDefaults = {
	readonly [_ in `${Pseudoterminal.SupportedPlatforms[number]
	}ExternalDefault`]: Settings.Profile.External
}
type IntegratedDefaults = {
	readonly [_ in `${Pseudoterminal.SupportedPlatforms[number]
	}IntegratedDefault`]: Settings.Profile.Integrated
}
export interface ProfilePresets extends ExternalDefaults, IntegratedDefaults {
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
export const PROFILE_PRESETS: ProfilePresets = deepFreeze({
	bashIntegrated: {
		args: [],
		executable: "/bin/bash",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	cmdExternal: {
		args: [],
		executable: WINDOWS_CMD_PATH,
		name: "",
		platforms: { win32: true },
		type: "external",
	},
	cmdIntegrated: {
		args: [],
		executable: WINDOWS_CMD_PATH,
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	darwinExternalDefault: {
		args: ["$PWD"],
		executable: TERMINAL_MACOS_PATH,
		name: "",
		platforms: { darwin: true },
		type: "external",
	},
	darwinIntegratedDefault: {
		args: [],
		executable: "/bin/zsh",
		name: "",
		platforms: { darwin: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	dashIntegrated: {
		args: [],
		executable: "/bin/dash",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	developerConsole: {
		name: "",
		type: "developerConsole",
	},
	empty: {
		name: "",
		type: "",
	},
	gitBashIntegrated: {
		args: [],
		executable: "C:\\Program Files\\Git\\bin\\bash.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	gnomeTerminalExternal: {
		args: [],
		executable: "gnome-terminal",
		name: "",
		platforms: { linux: true },
		type: "external",
	},
	konsoleExternal: {
		args: [],
		executable: "konsole",
		name: "",
		platforms: { linux: true },
		type: "external",
	},
	linuxExternalDefault: {
		args: [],
		executable: "xterm",
		name: "",
		platforms: { linux: true },
		type: "external",
	},
	linuxIntegratedDefault: {
		args: [],
		executable: "/bin/sh",
		name: "",
		platforms: { linux: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	pwshIntegrated: {
		args: [],
		executable: "pwsh",
		name: "",
		platforms: { darwin: true, linux: true, win32: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	shIntegrated: {
		args: [],
		executable: "/bin/sh",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	terminalMacOSExternal: {
		args: [],
		executable: TERMINAL_MACOS_PATH,
		name: "",
		platforms: { darwin: true },
		type: "external",
	},
	win32ExternalDefault: {
		args: [],
		executable: WINDOWS_CMD_PATH,
		name: "",
		platforms: { win32: true },
		type: "external",
	},
	win32IntegratedDefault: {
		args: [],
		executable: WINDOWS_CMD_PATH,
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	wslIntegrated: {
		args: [],
		executable: "C:\\Windows\\System32\\bash.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	wtExternal: {
		args: [],
		executable: "wt",
		name: "",
		platforms: { win32: true },
		type: "external",
	},
	xtermExternal: {
		args: [],
		executable: "xterm",
		name: "",
		platforms: { darwin: true, linux: true },
		type: "external",
	},
	zshIntegrated: {
		args: [],
		executable: "/bin/zsh",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
} as const)
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
	"darwinIntegratedDefault",
	"linuxExternalDefault",
	"linuxIntegratedDefault",
	"win32ExternalDefault",
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
