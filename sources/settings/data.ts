import type { InverseTypeofMap, PrimitiveOf } from "../utils/typeof"
import {
	type Sized,
	deepFreeze,
	inSet,
	isHomogenousArray,
	typedStructuredClone,
} from "../utils/util"
import { genericTypeofGuard, primitiveOf } from "../utils/typeof"
import { LANGUAGES } from "assets/locales"
import { NOTICE_NO_TIMEOUT } from "../magic"
import type { Plugin } from "obsidian"
import { RendererAddon } from "../terminal/emulator"
import type { TerminalPty } from "../terminal/pty"

export interface Settings {
	readonly language: Settings.DefaultableLanguage
	readonly addToCommand: boolean
	readonly addToContextMenu: boolean
	readonly hideStatusBar: Settings.HideStatusBarOption
	readonly noticeTimeout: number
	readonly errorNoticeTimeout: number
	readonly pythonExecutable: string
	readonly executables: Settings.Executables
	readonly enableWindowsConhostWorkaround: boolean
	readonly preferredRenderer: Settings.PreferredRendererOption
}
export const DEFAULT_SETTINGS: Settings = deepFreeze({
	addToCommand: true,
	addToContextMenu: true,
	enableWindowsConhostWorkaround: true,
	errorNoticeTimeout: NOTICE_NO_TIMEOUT,
	executables: {
		darwin: {
			extArgs: ["$PWD"],
			extExe:
				"/System/Applications/Utilities/Terminal.app/Contents/macOS/Terminal",
			intArgs: [],
			intExe: "/bin/zsh",
		},
		linux: {
			extArgs: [],
			extExe: "xterm",
			intArgs: [],
			intExe: "/bin/sh",
		},
		win32: {
			extArgs: [],
			extExe: "C:\\Windows\\System32\\cmd.exe",
			intArgs: [],
			intExe: "C:\\Windows\\System32\\cmd.exe",
		},
	},
	hideStatusBar: "focused",
	language: "",
	noticeTimeout: 5,
	preferredRenderer: "webgl",
	pythonExecutable: "python3",
} as const)
export namespace Settings {
	export const DEFAULTABLE_LANGUAGES = deepFreeze(["", ...LANGUAGES] as const)
	export type DefaultableLanguage = typeof DEFAULTABLE_LANGUAGES[number]
	export const HIDE_STATUS_BAR_OPTIONS =
		deepFreeze(["never", "always", "focused", "running"] as const)
	export type HideStatusBarOption = typeof HIDE_STATUS_BAR_OPTIONS[number]
	export const PREFERRED_RENDERER_OPTIONS = RendererAddon.RENDERER_OPTIONS
	export type PreferredRendererOption = RendererAddon.RendererOption
	export type Executables = {
		readonly [key in TerminalPty.SupportedPlatform]: Executables.Entry
	}
	export namespace Executables {
		export interface Entry {
			readonly intExe: string
			readonly intArgs: readonly string[]
			readonly extExe: string
			readonly extArgs: readonly string[]
		}
	}
	export function fix(self: unknown): Settings {
		type Unknownize<T> = { readonly [key in keyof T]?: unknown }
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
			enableWindowsConhostWorkaround: fixTyped(
				DEFAULT_SETTINGS,
				tmp,
				"enableWindowsConhostWorkaround",
				"boolean",
			),
			errorNoticeTimeout: fixTyped(
				DEFAULT_SETTINGS,
				tmp,
				"errorNoticeTimeout",
				"number",
			),
			executables: ((): Executables => {
				const defaults2 = DEFAULT_SETTINGS.executables
				if (typeof tmp.executables === "object") {
					const tmp2: Unknownize<Executables> =
						{ ...tmp.executables },
						fixEntry =
							<K extends keyof Executables>(key: K): Executables.Entry => {
								const defaults3 = defaults2[key],
									val = tmp2[key]
								if (typeof val === "object" && val !== null) {
									const tmp3: Unknownize<Executables.Entry> = { ...val }
									return {
										extArgs: fixArray(defaults3, tmp3, "extArgs", "string"),
										extExe: fixTyped(defaults3, tmp3, "extExe", "string"),
										intArgs: fixArray(defaults3, tmp3, "intArgs", "string"),
										intExe: fixTyped(defaults3, tmp3, "intExe", "string"),
									}
								}
								return typedStructuredClone(defaults3)
							}
					return {
						darwin: fixEntry("darwin"),
						linux: fixEntry("linux"),
						win32: fixEntry("win32"),
					}
				}
				return typedStructuredClone(defaults2)
			})(),
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
			pythonExecutable:
				fixTyped(DEFAULT_SETTINGS, tmp, "pythonExecutable", "string"),
		}
	}
	export async function load(self: Settings, plugin: Plugin): Promise<void> {
		Object.assign(self, fix(await plugin.loadData()))
	}
	export async function save(self: Settings, plugin: Plugin): Promise<void> {
		await plugin.saveData(self)
	}
}
