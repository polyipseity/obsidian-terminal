import {
	type AnyObject,
	NULL_SEM_VER_STRING,
	type SemVerString,
	type Sized,
	type Unchecked,
	launderUnchecked,
	opaqueOrDefault,
	semVerString,
} from "sources/utils/types"
import type { DeepRequired, DeepWritable, MarkOptional } from "ts-essentials"
import {
	type Fixed,
	fixArray,
	fixInSet,
	fixTyped,
	markFixed,
} from "sources/ui/fixers"
import {
	type Platform,
	cloneAsWritable,
	deepFreeze,
	inSet,
	isUndefined,
} from "../utils/util"
import { LANGUAGES } from "assets/locales"
import { NOTICE_NO_TIMEOUT } from "sources/magic"
import { PROFILE_PRESETS } from "./profile-presets"
import { Pseudoterminal } from "../terminal/pseudoterminal"
import { RendererAddon } from "../terminal/emulator"

export interface Settings {
	readonly language: Settings.DefaultableLanguage
	readonly addToCommand: boolean
	readonly addToContextMenu: boolean
	readonly profiles: Settings.Profiles
	readonly hideStatusBar: Settings.HideStatusBarOption
	readonly noticeTimeout: number
	readonly errorNoticeTimeout: number

	readonly preferredRenderer: Settings.PreferredRendererOption

	readonly lastReadChangelogVersion: SemVerString
	readonly recovery: Settings.Recovery
}
export namespace Settings {
	export const optionals = deepFreeze([
		"lastReadChangelogVersion",
		"recovery",
	] as const) satisfies readonly (keyof Settings)[]
	export type Optionals = typeof optionals[number]
	export type Persistent = Omit<Settings, Optionals>
	export function persistent(settings: Settings): Persistent {
		const ret: MarkOptional<Settings, Optionals> = cloneAsWritable(settings)
		for (const optional of optionals) {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete ret[optional]
		}
		return ret
	}
	export const DEFAULT: Persistent = deepFreeze({
		addToCommand: true,
		addToContextMenu: true,
		errorNoticeTimeout: NOTICE_NO_TIMEOUT,
		hideStatusBar: "focused",
		language: "",
		noticeTimeout: 5,
		preferredRenderer: "webgl",
		profiles: Object.fromEntries(([
			"darwinExternalDefault",
			"darwinIntegratedDefault",
			"developerConsole",
			"linuxExternalDefault",
			"linuxIntegratedDefault",
			"win32ExternalDefault",
			"win32IntegratedDefault",
		] as const).map(key => [key, PROFILE_PRESETS[key]])),
	} as const)
	export type Recovery = Readonly<Record<string, string>>
	export const DEFAULTABLE_LANGUAGES =
		Object.freeze(["", ...LANGUAGES] as const)
	export type DefaultableLanguage = typeof DEFAULTABLE_LANGUAGES[number]
	export const HIDE_STATUS_BAR_OPTIONS =
		Object.freeze(["never", "always", "focused", "running"] as const)
	export type HideStatusBarOption = typeof HIDE_STATUS_BAR_OPTIONS[number]
	export const PREFERRED_RENDERER_OPTIONS = RendererAddon.RENDERER_OPTIONS
	export type PreferredRendererOption = RendererAddon.RendererOption
	export type Profile =
		Profile.DeveloperConsole |
		Profile.Empty |
		Profile.External |
		Profile.Integrated |
		Profile.Invalid
	export type Profiles = Readonly<Record<string, Profile>>
	export namespace Profile {
		export type Entry = readonly [key: string, value: Profile]
		export const TYPES =
			Object.freeze([
				"",
				"invalid",
				"developerConsole",
				"external",
				"integrated",
			] as const)
		export type Type = typeof TYPES[number]
		export type Typed<T extends Type> = Profile & { readonly type: T }
		export function defaultOfType<T extends Type>(
			type: T,
			profiles: Profiles,
			platform?: Platform,
		): Typed<T> | null {
			for (const profile of Object.values(profiles)) {
				if (isType(type, profile) &&
					(isUndefined(platform) || isCompatible(profile, platform))) {
					return profile
				}
			}
			return null
		}
		export function isCompatible(
			profile: Profile,
			platform: Platform,
		): boolean {
			if (!("platforms" in profile)) { return true }
			const platforms = launderUnchecked<AnyObject>(profile.platforms),
				supported = platforms[platform]
			if (typeof supported === "boolean" && supported) {
				return true
			}
			return false
		}
		export function isType<T extends Type>(
			type: T,
			profile: Profile,
		): profile is Typed<T> {
			return profile.type === type
		}
		export function name(profile: Profile): string {
			const { name: name0 } = profile
			if (typeof name0 === "string") { return name0 }
			return ""
		}
		export function info([id, profile]: Entry): {
			readonly id: string
			readonly name: string
			readonly nameOrID: string
			readonly profile: Profile
		} {
			const name0 = name(profile)
			return Object.freeze({
				id,
				name: name0,
				nameOrID: name0 || id,
				profile,
			})
		}
		export type Platforms<T extends string> = { readonly [_ in T]?: boolean }
		interface Base {
			readonly type: Type
			readonly name: string
		}
		export interface Empty extends Base {
			readonly type: ""
		}
		export interface Invalid {
			readonly [_: string]: unknown
			readonly type: "invalid"
		}
		export interface DeveloperConsole extends Base {
			readonly type: "developerConsole"
		}
		export interface External extends Base {
			readonly type: "external"
			readonly executable: string
			readonly args: readonly string[]
			readonly platforms: Platforms<Pseudoterminal.SupportedPlatform>
		}
		export interface Integrated extends Base {
			readonly type: "integrated"
			readonly executable: string
			readonly args: readonly string[]
			readonly platforms: Platforms<Pseudoterminal.SupportedPlatform>
			readonly pythonExecutable: string
			readonly useWin32Conhost: boolean
		}
		export const DEFAULTS: {
			readonly [key in Type]: DeepRequired<Typed<key>>
		} = deepFreeze({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			"": PROFILE_PRESETS.empty,
			developerConsole: {
				name: "",
				type: "developerConsole",
			},
			external: {
				args: [],
				executable: "",
				name: "",
				platforms: {
					darwin: false,
					linux: false,
					win32: false,
				},
				type: "external",
			},
			integrated: {
				args: [],
				executable: "",
				name: "",
				platforms: {
					darwin: false,
					linux: false,
					win32: false,
				},
				pythonExecutable: "",
				type: "integrated",
				useWin32Conhost: false,
			},
			invalid: {
				type: "invalid",
			},
		} as const)
		// eslint-disable-next-line @typescript-eslint/no-shadow
		export function fix(self: unknown): Fixed<Profile> {
			const unc = launderUnchecked<Invalid>(self),
				fixPlatforms = <
					V extends Platforms<Vs[number]>,
					Vs extends readonly string[],
				>(
					defaults: V,
					from: Unchecked<V>,
					set: Sized<Vs>,
				): Platforms<Vs[number]> => {
					const ret2: { [_ in Vs[number]]?: boolean } = {}
					for (const platform0 of set) {
						const platform: Vs[number] = platform0
						if (!(platform in from)) { continue }
						const value = from[platform]
						ret2[platform] = typeof value === "boolean"
							? value
							: defaults[platform]
					}
					return ret2
				}
			// eslint-disable-next-line consistent-return
			return markFixed(self, ((): DeepWritable<Profile> => {
				const type = inSet(TYPES, unc.type)
					? unc.type
					: "invalid"
				switch (type) {
					case "": {
						return {
							name: fixTyped(
								DEFAULTS[type],
								unc,
								"name",
								["string"],
							),
							type,
						} satisfies Typed<typeof type>
					}
					case "developerConsole": {
						return {
							name: fixTyped(
								DEFAULTS[type],
								unc,
								"name",
								["string"],
							),
							type,
						} satisfies Typed<typeof type>
					}
					case "external": {
						return {
							args: fixArray(
								DEFAULTS[type],
								unc,
								"args",
								["string"],
							),
							executable: fixTyped(
								DEFAULTS[type],
								unc,
								"executable",
								["string"],
							),
							name: fixTyped(
								DEFAULTS[type],
								unc,
								"name",
								["string"],
							),
							platforms: fixPlatforms(
								DEFAULTS[type].platforms,
								unc["platforms"] ?? {},
								Pseudoterminal.SUPPORTED_PLATFORMS,
							),
							type,
						} satisfies Typed<typeof type>
					}
					case "integrated": {
						return {
							args: fixArray(
								DEFAULTS[type],
								unc,
								"args",
								["string"],
							),
							executable: fixTyped(
								DEFAULTS[type],
								unc,
								"executable",
								["string"],
							),
							name: fixTyped(
								DEFAULTS[type],
								unc,
								"name",
								["string"],
							),
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
							type,
							useWin32Conhost: fixTyped(
								DEFAULTS[type],
								unc,
								"useWin32Conhost",
								["boolean"],
							),
						} satisfies Typed<typeof type>
					}
					case "invalid": {
						return {
							...unc,
							type,
						} satisfies Typed<typeof type>
					}
					// No default
				}
			})())
		}
	}
	export function fix(self: unknown): Fixed<Settings> {
		const unc = launderUnchecked<Settings>(self)
		return markFixed(self, {
			addToCommand: fixTyped(
				DEFAULT,
				unc,
				"addToCommand",
				["boolean"],
			),
			addToContextMenu: fixTyped(
				DEFAULT,
				unc,
				"addToContextMenu",
				["boolean"],
			),
			errorNoticeTimeout: fixTyped(
				DEFAULT,
				unc,
				"errorNoticeTimeout",
				["number"],
			),
			hideStatusBar: fixInSet(
				DEFAULT,
				unc,
				"hideStatusBar",
				HIDE_STATUS_BAR_OPTIONS,
			),
			language: fixInSet(
				DEFAULT,
				unc,
				"language",
				DEFAULTABLE_LANGUAGES,
			),
			lastReadChangelogVersion: opaqueOrDefault(
				semVerString,
				String(unc.lastReadChangelogVersion),
				NULL_SEM_VER_STRING,
			),
			noticeTimeout: fixTyped(
				DEFAULT,
				unc,
				"noticeTimeout",
				["number"],
			),
			preferredRenderer: fixInSet(
				DEFAULT,
				unc,
				"preferredRenderer",
				PREFERRED_RENDERER_OPTIONS,
			),
			profiles: ((): DeepWritable<Profiles> => {
				const defaults2 = DEFAULT.profiles,
					{ profiles } = unc
				if (typeof profiles === "object" && profiles !== null) {
					return Object.fromEntries(Object.entries(profiles)
						.map(([id, profile]) => [id, Profile.fix(profile).value]))
				}
				return cloneAsWritable(defaults2)
			})(),
			recovery: Object.fromEntries(Object
				.entries(launderUnchecked(unc.recovery))
				.map(([key, value]) => [key, String(value)])),
		})
	}
}
