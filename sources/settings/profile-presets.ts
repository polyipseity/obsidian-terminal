import { deepFreeze, typedKeys } from "sources/utils/util"
import type { Pseudoterminal } from "sources/terminal/pseudoterminal"
import type { Settings } from "./data"

type ExternalDefaults = {
	readonly [_ in `${Pseudoterminal.SupportedPlatform
	}ExternalDefault`]: Settings.Profile.External
}
type IntegratedDefaults = {
	readonly [_ in `${Pseudoterminal.SupportedPlatform
	}IntegratedDefault`]: Settings.Profile.Integrated
}
export interface ProfilePresets extends ExternalDefaults, IntegratedDefaults {
	readonly empty: Settings.Profile.Empty
	readonly console: Settings.Profile.Console

	readonly cmdIntegrated: Settings.Profile.Integrated
	readonly bashIntegrated: Settings.Profile.Integrated
	readonly dashIntegrated: Settings.Profile.Integrated
	readonly pwshIntegrated: Settings.Profile.Integrated
	readonly shIntegrated: Settings.Profile.Integrated
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
		useWin32Conhost: false,
	},
	cmdIntegrated: {
		args: [],
		executable: "C:\\Windows\\System32\\cmd.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	console: {
		name: "",
		type: "console",
	},
	darwinExternalDefault: {
		args: ["$PWD"],
		executable:
			"/System/Applications/Utilities/Terminal.app/Contents/macOS/Terminal",
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
		useWin32Conhost: false,
	},
	dashIntegrated: {
		args: [],
		executable: "/bin/dash",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: false,
	},
	empty: {
		name: "",
		type: "",
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
		useWin32Conhost: false,
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
		useWin32Conhost: false,
	},
	win32ExternalDefault: {
		args: [],
		executable: "C:\\Windows\\System32\\cmd.exe",
		name: "",
		platforms: { win32: true },
		type: "external",
	},
	win32IntegratedDefault: {
		args: [],
		executable: "C:\\Windows\\System32\\cmd.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: true,
	},
	zshIntegrated: {
		args: [],
		executable: "/bin/zsh",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
		useWin32Conhost: false,
	},
} as const)
export const PROFILE_PRESET_KEYS = typedKeys<readonly [
	"empty",
	"console",
	"cmdIntegrated",
	"bashIntegrated",
	"dashIntegrated",
	"pwshIntegrated",
	"shIntegrated",
	"zshIntegrated",
	"darwinExternalDefault",
	"darwinIntegratedDefault",
	"linuxExternalDefault",
	"linuxIntegratedDefault",
	"win32ExternalDefault",
	"win32IntegratedDefault",
]>()(PROFILE_PRESETS)
export type ProfilePresetKeys = typeof PROFILE_PRESET_KEYS[number]
export const PROFILE_PRESET_ORDERED_KEYS =
	deepFreeze(PROFILE_PRESET_KEYS.reduce<ProfilePresetKeys[]>((prev, cur) => {
		if (cur === "empty") {
			prev.unshift(cur)
		} else {
			prev.push(cur)
		}
		return prev
	}, []))
