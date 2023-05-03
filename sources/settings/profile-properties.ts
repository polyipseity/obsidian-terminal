import { type AnyObject, launderUnchecked } from "sources/utils/types"
import {
	Pseudoterminal,
	RefPsuedoterminal,
	TextPseudoterminal,
} from "../terminal/pseudoterminal"
import {
	SUPPORTS_EXTERNAL_TERMINAL_EMULATOR,
	spawnExternalTerminalEmulator,
} from "../terminal/emulator"
import type { AsyncOrSync } from "ts-essentials"
import { Platform } from "sources/utils/platforms"
import type { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"
import { UNDEFINED } from "sources/magic"
import { deepFreeze } from "sources/utils/util"

export interface OpenOptions {
	readonly cwd?: string | null
	readonly terminal?: string | null
}
export const PROFILE_PROPERTIES: {
	readonly [key in Settings.Profile.Type]: {
		readonly available: boolean
		readonly valid: boolean
		readonly integratable: boolean
		readonly opener: (
			plugin: TerminalPlugin,
			profile: Settings.Profile.Typed<key>,
			options?: OpenOptions,
		) => AsyncOrSync<RefPsuedoterminal<Pseudoterminal> | null>
	}
} = deepFreeze({
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"": {
		available: true,
		integratable: true,
		opener() {
			return new RefPsuedoterminal(new TextPseudoterminal())
		},
		valid: true,
	},
	developerConsole: {
		available: true,
		integratable: true,
		opener(plugin: TerminalPlugin) { return plugin.consolePTY.dup() },
		valid: true,
	},
	external: {
		available: SUPPORTS_EXTERNAL_TERMINAL_EMULATOR,
		integratable: false,
		async opener(
			_plugin: TerminalPlugin,
			profile: Settings.Profile.Typed<"external">,
			options?: OpenOptions,
		) {
			await spawnExternalTerminalEmulator(
				profile.executable,
				profile.args,
				options?.cwd ?? UNDEFINED,
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
			options?: OpenOptions,
		) {
			if (!Pseudoterminal.PLATFORM_PSEUDOTERMINAL) { return null }
			const
				{
					args,
					platforms,
					useWin32Conhost,
					executable,
					pythonExecutable,
				} = profile,
				supported = launderUnchecked<AnyObject>(platforms)[Platform.CURRENT]
			if (typeof supported !== "boolean" || !supported) { return null }
			return new RefPsuedoterminal(
				new Pseudoterminal.PLATFORM_PSEUDOTERMINAL(plugin, {
					args,
					cwd: options?.cwd ?? null,
					executable,
					pythonExecutable: pythonExecutable || null,
					terminal: options?.terminal ?? null,
					useWin32Conhost,
				}),
			)
		},
		valid: true,
	},
	invalid: {
		available: true,
		integratable: true,
		opener() { return null },
		valid: false,
	},
})

export function openProfile<T extends Settings.Profile.Type>(
	plugin: TerminalPlugin,
	profile: Settings.Profile.Typed<T>,
	options?: OpenOptions,
): AsyncOrSync<RefPsuedoterminal<Pseudoterminal> | null> {
	const type0: T = profile.type
	return PROFILE_PROPERTIES[type0].opener(plugin, profile, options)
}
