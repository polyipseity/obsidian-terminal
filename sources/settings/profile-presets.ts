import type { Settings } from "./data"
import type { TerminalPty } from "sources/terminal/pty"
import { deepFreeze } from "sources/utils/util"

type ExternalDefaults = {
	readonly [_ in `${TerminalPty.SupportedPlatform
	}ExternalDefault`]: Settings.Profile.External
}
type IntegratedDefaults = {
	readonly [_ in `${TerminalPty.SupportedPlatform
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
	},
	cmdIntegrated: {
		args: [],
		enableWindowsConhostWorkaround: true,
		executable: "C:\\Windows\\System32\\cmd.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
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
	},
	dashIntegrated: {
		args: [],
		executable: "/bin/dash",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
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
	},
	pwshIntegrated: {
		args: [],
		enableWindowsConhostWorkaround: true,
		executable: "pwsh",
		name: "",
		platforms: { darwin: true, linux: true, win32: true },
		pythonExecutable: "python3",
		type: "integrated",
	},
	shIntegrated: {
		args: [],
		executable: "/bin/sh",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
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
		enableWindowsConhostWorkaround: true,
		executable: "C:\\Windows\\System32\\cmd.exe",
		name: "",
		platforms: { win32: true },
		pythonExecutable: "python3",
		type: "integrated",
	},
	zshIntegrated: {
		args: [],
		executable: "/bin/zsh",
		name: "",
		platforms: { darwin: true, linux: true },
		pythonExecutable: "python3",
		type: "integrated",
	},
} as const)
const {
	console,
	darwinExternalDefault,
	darwinIntegratedDefault,
	linuxExternalDefault,
	linuxIntegratedDefault,
	win32ExternalDefault,
	win32IntegratedDefault,
} = PROFILE_PRESETS
export const PROFILE_DEFAULTS = deepFreeze({
	console,
	darwinExternalDefault,
	darwinIntegratedDefault,
	linuxExternalDefault,
	linuxIntegratedDefault,
	win32ExternalDefault,
	win32IntegratedDefault,
} as const)
