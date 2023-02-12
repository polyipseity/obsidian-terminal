import type { DeepRequired, DeepWritable } from "ts-essentials"
import {
	type InverseTypeofMap,
	type PrimitiveOf,
	genericTypeofGuard,
	primitiveOf,
} from "../utils/typeof"
import {
	PLATFORM,
	type Platform,
	cloneAsWritable,
	deepFreeze,
	inSet,
	isHomogenousArray,
} from "../utils/util"
import { LANGUAGES } from "assets/locales"
import { NOTICE_NO_TIMEOUT } from "sources/magic"
import { PROFILE_PRESETS } from "./profile-presets"
import { Pseudoterminal } from "../terminal/pseudoterminal"
import { RendererAddon } from "../terminal/emulator"
import type { Sized } from "sources/utils/types"

export interface Settings {
	readonly language: Settings.DefaultableLanguage
	readonly addToCommand: boolean
	readonly addToContextMenu: boolean
	readonly hideStatusBar: Settings.HideStatusBarOption
	readonly noticeTimeout: number
	readonly errorNoticeTimeout: number
	readonly profiles: Settings.Profiles
	readonly preferredRenderer: Settings.PreferredRendererOption
}
export const DEFAULT_SETTINGS = deepFreeze({
	addToCommand: true,
	addToContextMenu: true,
	errorNoticeTimeout: NOTICE_NO_TIMEOUT,
	hideStatusBar: "focused",
	language: "",
	noticeTimeout: 5,
	preferredRenderer: "webgl",
	profiles: Object.fromEntries(([
		"console",
		"darwinExternalDefault",
		"darwinIntegratedDefault",
		"linuxExternalDefault",
		"linuxIntegratedDefault",
		"win32ExternalDefault",
		"win32IntegratedDefault",
	] as const).map(key => [key, PROFILE_PRESETS[key]])),
} as const) satisfies Settings
export namespace Settings {
	export const DEFAULTABLE_LANGUAGES =
		Object.freeze(["", ...LANGUAGES] as const)
	export type DefaultableLanguage = typeof DEFAULTABLE_LANGUAGES[number]
	export const HIDE_STATUS_BAR_OPTIONS =
		Object.freeze(["never", "always", "focused", "running"] as const)
	export type HideStatusBarOption = typeof HIDE_STATUS_BAR_OPTIONS[number]
	export const PREFERRED_RENDERER_OPTIONS = RendererAddon.RENDERER_OPTIONS
	export type PreferredRendererOption = RendererAddon.RendererOption
	export type Profile =
		Profile.Console |
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
				"console",
				"external",
				"integrated",
			] as const)
		export type Type = typeof TYPES[number]
		export type Typed<T extends Type> = Profile & { readonly type: T }
		export function defaultOfType<T extends Type>(
			type: T,
			profiles: Profiles,
			platform: Platform | null = PLATFORM,
		): Typed<T> | null {
			for (const profile of Object.values(profiles)) {
				if (isType(type, profile)) {
					if (platform === null || !("platforms" in profile)) {
						return profile
					}
					const { platforms } = profile
					if (platforms !== null && typeof platforms === "object") {
						const ptfs: Readonly<Record<string, unknown>> = { ...platforms },
							supported = ptfs[platform]
						if (typeof supported === "boolean" && supported) {
							return profile
						}
					}
				}
			}
			return null
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
		export function nameOrID(entry: Entry): string {
			return name(entry[1]) || entry[0]
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
		export interface Console extends Base {
			readonly type: "console"
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
			readonly enableWindowsConhostWorkaround?: boolean
		}
		export const DEFAULTS: {
			readonly [key in Type]: DeepRequired<Typed<key>>
		} = deepFreeze({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			"": PROFILE_PRESETS.empty,
			console: {
				name: "",
				type: "console",
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
				enableWindowsConhostWorkaround: false,
				executable: "",
				name: "",
				platforms: {
					darwin: false,
					linux: false,
					win32: false,
				},
				pythonExecutable: "",
				type: "integrated",
			},
			invalid: {
				type: "invalid",
			},
		} as const)
	}
	export function fix(self: unknown): DeepWritable<Settings> {
		type Unknownize<T> = { readonly [_ in keyof T]?: unknown }
		const tmp: Unknownize<Settings> = {}
		Object.assign(tmp, self)
		const
			fixTyped = <S, K extends keyof S>(
				defaults: S,
				from: Unknownize<S>,
				key: K,
				type: InverseTypeofMap<S[K]>,
			): PrimitiveOf<S[K]> => {
				const val = from[key]
				return genericTypeofGuard(type, val)
					? val
					: primitiveOf(defaults[key])
			},
			fixArray = <S,
				K extends keyof S,
				V extends S[K] extends readonly (infer V0)[] ? V0 : never,
			>(
				defaults: S,
				from: Unknownize<S>,
				key: K,
				type: InverseTypeofMap<V>,
			): PrimitiveOf<V>[] => {
				const val = from[key]
				if (isHomogenousArray(type, val)) { return val }
				const default0 = defaults[key]
				if (!Array.isArray(default0)) { throw new TypeError(String(default0)) }
				const default1: readonly V[] = default0
				return default1.map(primitiveOf)
			},
			fixInSet = <S, K extends keyof S, Vs extends readonly S[K][]>(
				defaults: S,
				from: Unknownize<S>,
				key: K,
				set: Sized<Vs>,
			): Vs[number] => {
				const val = from[key]
				return inSet(set, val) ? val : defaults[key]
			}
		return {
			addToCommand: fixTyped(DEFAULT_SETTINGS, tmp, "addToCommand", "boolean"),
			addToContextMenu: fixTyped(
				DEFAULT_SETTINGS,
				tmp,
				"addToContextMenu",
				"boolean",
			),
			errorNoticeTimeout: fixTyped(
				DEFAULT_SETTINGS,
				tmp,
				"errorNoticeTimeout",
				"number",
			),
			hideStatusBar: fixInSet(
				DEFAULT_SETTINGS,
				tmp,
				"hideStatusBar",
				HIDE_STATUS_BAR_OPTIONS,
			),
			language: fixInSet(
				DEFAULT_SETTINGS,
				tmp,
				"language",
				DEFAULTABLE_LANGUAGES,
			),
			noticeTimeout: fixTyped(DEFAULT_SETTINGS, tmp, "noticeTimeout", "number"),
			preferredRenderer: fixInSet(
				DEFAULT_SETTINGS,
				tmp,
				"preferredRenderer",
				PREFERRED_RENDERER_OPTIONS,
			),
			profiles: ((): DeepWritable<Profiles> => {
				const defaults2 = DEFAULT_SETTINGS.profiles,
					{ profiles } = tmp
				if (profiles !== null && typeof profiles === "object") {
					const ret: DeepWritable<Profiles> = {}
					for (const [id, profile0] of Object.entries(profiles)) {
						const profile1: unknown = profile0,
							fixPlatforms = <
								V extends Profile.Platforms<Vs[number]>,
								Vs extends readonly string[],
							>(
								defaults: V,
								from: Unknownize<V>,
								set: Sized<Vs>,
							): Profile.Platforms<Vs[number]> => {
								const ret2: { [_ in Vs[number]]?: boolean } = {}
								for (const platform0 of set) {
									const platform: Vs[number] = platform0,
										value = from[platform]
									ret2[platform] = typeof value === "boolean"
										? value
										: defaults[platform]
								}
								return ret2
							}
						if (profile1 !== null && typeof profile1 === "object") {
							const
								profile: Readonly<Record<string, unknown>> = { ...profile1 },
								type = inSet(Profile.TYPES, profile["type"])
									? profile["type"]
									: "invalid"
							switch (type) {
								case "": {
									ret[id] = {
										name: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"name",
											"string",
										),
										type,
									} satisfies Required<Profile.Typed<typeof type>>
									break
								}
								case "console": {
									ret[id] = {
										name: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"name",
											"string",
										),
										type,
									} satisfies Required<Profile.Typed<typeof type>>
									break
								}
								case "external": {
									ret[id] = {
										args: fixArray(
											Profile.DEFAULTS[type],
											profile,
											"args",
											"string",
										),
										executable: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"executable",
											"string",
										),
										name: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"name",
											"string",
										),
										platforms: fixPlatforms(
											Profile.DEFAULTS[type].platforms,
											profile["platforms"] ?? {},
											Pseudoterminal.SUPPORTED_PLATFORMS,
										),
										type,
									} satisfies Required<Profile.Typed<typeof type>>
									break
								}
								case "integrated": {
									ret[id] = {
										args: fixArray(
											Profile.DEFAULTS[type],
											profile,
											"args",
											"string",
										),
										enableWindowsConhostWorkaround: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"enableWindowsConhostWorkaround",
											"boolean",
										),
										executable: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"executable",
											"string",
										),
										name: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"name",
											"string",
										),
										platforms: fixPlatforms(
											Profile.DEFAULTS[type].platforms,
											profile["platforms"] ?? {},
											Pseudoterminal.SUPPORTED_PLATFORMS,
										),
										pythonExecutable: fixTyped(
											Profile.DEFAULTS[type],
											profile,
											"pythonExecutable",
											"string",
										),
										type,
									} satisfies Required<Profile.Typed<typeof type>>
									break
								}
								case "invalid": {
									ret[id] = {
										...profile,
										type,
									} satisfies Required<Profile.Typed<typeof type>>
									break
								}
								// No default
							}
						}
					}
					return ret
				}
				return cloneAsWritable(defaults2)
			})(),
		}
	}
}
