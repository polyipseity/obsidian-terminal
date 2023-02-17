import {
	ConsolePseudoterminal,
	Pseudoterminal,
	TextPseudoterminal,
} from "../terminal/pseudoterminal"
import {
	PLATFORM,
	deepFreeze,
} from "sources/utils/util"
import {
	SUPPORTS_EXTERNAL_TERMINAL_EMULATOR,
	spawnExternalTerminalEmulator,
} from "../terminal/emulator"
import type { AsyncOrSync } from "ts-essentials"
import type { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"

export const PROFILE_PROPERTIES: {
	readonly [key in Settings.Profile.Type]: {
		readonly available: boolean
		readonly valid: boolean
		readonly integratable: boolean
		readonly opener: (
			plugin: TerminalPlugin,
			profile: Settings.Profile.Typed<key>,
			cwd?: string,
		) => AsyncOrSync<Pseudoterminal | null>
	}
} = deepFreeze({
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"": {
		available: true,
		integratable: true,
		opener() {
			return new TextPseudoterminal()
		},
		valid: true,
	},
	developerConsole: {
		available: true,
		integratable: true,
		opener() {
			return new ConsolePseudoterminal()
		},
		valid: true,
	},
	external: {
		available: SUPPORTS_EXTERNAL_TERMINAL_EMULATOR,
		integratable: false,
		async opener(
			_plugin: TerminalPlugin,
			profile: Settings.Profile.Typed<"external">,
			cwd?: string,
		) {
			await spawnExternalTerminalEmulator(
				profile.executable,
				profile.args,
				cwd,
			)
			return null
		},
		valid: true,
	},
	integrated: {
		available: Pseudoterminal.PLATFORM_PSEUDOTERMINAL !== null,
		integratable: true,
		opener(
			plugin: TerminalPlugin,
			profile: Settings.Profile.Typed<"integrated">,
			cwd?: string,
		) {
			if (Pseudoterminal.PLATFORM_PSEUDOTERMINAL === null) {
				return null
			}
			const
				{
					args,
					platforms,
					useWin32Conhost,
					executable,
					pythonExecutable,
				} = profile,
				platforms0: Readonly<Record<string, boolean>> = platforms
			if (!(platforms0[PLATFORM] ?? false)) { return null }
			return new Pseudoterminal.PLATFORM_PSEUDOTERMINAL(plugin, {
				args,
				cwd: cwd ?? null,
				executable,
				pythonExecutable: pythonExecutable || null,
				useWin32Conhost,
			})
		},
		valid: true,
	},
	invalid: {
		available: true,
		integratable: false,
		opener() { return null },
		valid: false,
	},
} as const)

export function openProfile<T extends Settings.Profile.Type>(
	plugin: TerminalPlugin,
	profile: Settings.Profile.Typed<T>,
	cwd?: string,
): AsyncOrSync<Pseudoterminal | null> {
	const type0: T = profile.type
	return PROFILE_PROPERTIES[type0].opener(plugin, profile, cwd)
}
