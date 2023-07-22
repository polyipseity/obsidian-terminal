import {
	type AnyObject,
	type Fixed,
	NOTICE_NO_TIMEOUT,
	NULL_SEM_VER_STRING,
	type Platform,
	type PluginContext,
	type ReadonlyTuple,
	type SemVerString,
	type Unchecked,
	cloneAsWritable,
	deepFreeze,
	fixArray,
	fixInSet,
	fixTyped,
	inSet,
	isHomogenousArray,
	launderUnchecked,
	markFixed,
	opaqueOrDefault,
	semVerString,
} from "@polyipseity/obsidian-plugin-library"
import {
	DEFAULT_LINK_HANDLER,
	DEFAULT_TERMINAL_OPTIONS,
	DEFAULT_THEME,
	DEFAULT_WINDOWS_PTY,
	DEFAULT_WINDOW_OPTIONS,
	type LinkHandlerFunc,
	PROFILE_PRESETS,
} from "./terminal/profile-presets.js"
import {
	DEFAULT_SUCCESS_EXIT_CODES,
	UNDEFINED,
} from "./magic.js"
import type {
	DeepReadonly,
	DeepRequired,
	DeepUndefinable,
	DeepWritable,
	MarkOptional,
} from "ts-essentials"
import type {
	FontWeight,
	ILinkHandler,
	ITerminalOptions,
	ITheme,
	IWindowOptions,
	IWindowsPty,
} from "xterm"
import { isUndefined, omitBy } from "lodash-es"
import { PluginLocales } from "../assets/locales.js"
import { Pseudoterminal } from "./terminal/pseudoterminal.js"
import { RendererAddon } from "./terminal/emulator-addons.js"

export interface Settings extends PluginContext.Settings {
	readonly language: Settings.DefaultableLanguage

	readonly openChangelogOnUpdate: boolean
	readonly addToCommand: boolean
	readonly addToContextMenu: boolean
	readonly profiles: Settings.Profiles
	readonly newInstanceBehavior: Settings.NewInstanceBehavior
	readonly createInstanceNearExistingOnes: boolean
	readonly focusOnNewInstance: boolean
	readonly pinNewInstance: boolean
	readonly hideStatusBar: Settings.HideStatusBarOption

	readonly preferredRenderer: Settings.PreferredRendererOption

	readonly lastReadChangelogVersion: SemVerString
}
export namespace Settings {
	export const optionals = deepFreeze([
		"lastReadChangelogVersion",
		"recovery",
	]) satisfies readonly (keyof Settings)[]
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
		createInstanceNearExistingOnes: true,
		errorNoticeTimeout: NOTICE_NO_TIMEOUT,
		focusOnNewInstance: true,
		hideStatusBar: "focused",
		language: "",
		newInstanceBehavior: "newHorizontalSplit",
		noticeTimeout: 5,
		openChangelogOnUpdate: true,
		pinNewInstance: true,
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
	})

	export const DEFAULTABLE_LANGUAGES =
		deepFreeze(["", ...PluginLocales.LANGUAGES])
	export type DefaultableLanguage = typeof DEFAULTABLE_LANGUAGES[number]

	export const NEW_INSTANCE_BEHAVIORS = deepFreeze([
		"replaceTab",
		"newTab",
		"newLeftTab",
		"newLeftSplit",
		"newRightTab",
		"newRightSplit",
		"newHorizontalSplit",
		"newVerticalSplit",
		"newWindow",
	])
	export type NewInstanceBehavior = typeof NEW_INSTANCE_BEHAVIORS[number]

	export const HIDE_STATUS_BAR_OPTIONS =
		deepFreeze(["never", "always", "focused", "running"])
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
		export const TYPES = deepFreeze([
			"",
			"invalid",
			"developerConsole",
			"external",
			"integrated",
		])
		export type Type = typeof TYPES[number]
		export type Typed<T extends Type> = Profile & { readonly type: T }
		export function defaultOfType<T extends Type>(
			type: T,
			profiles: Profiles,
			platform?: Platform.All,
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
			platform: Platform.All,
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
			readonly restoreHistory: boolean
			readonly successExitCodes: readonly string[]
			readonly terminalOptions: TerminalOptions
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
			readonly platforms: Platforms<Pseudoterminal.SupportedPlatforms[number]>
		}
		export interface Integrated extends Base {
			readonly type: "integrated"
			readonly executable: string
			readonly args: readonly string[]
			readonly platforms: Platforms<Pseudoterminal.SupportedPlatforms[number]>
			readonly pythonExecutable: string
			readonly useWin32Conhost: boolean
		}
		export const DEFAULTS: {
			readonly [key in Type]: DeepRequired<Omit<Typed<key>, "terminalOptions">>
			& Typed<key>
		} = deepFreeze({
			// eslint-disable-next-line @typescript-eslint/naming-convention
			"": PROFILE_PRESETS.empty,
			developerConsole: {
				name: "",
				restoreHistory: true,
				successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
				terminalOptions: DEFAULT_TERMINAL_OPTIONS,
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
				restoreHistory: true,
				successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
				terminalOptions: DEFAULT_TERMINAL_OPTIONS,
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
				restoreHistory: true,
				successExitCodes: DEFAULT_SUCCESS_EXIT_CODES,
				terminalOptions: DEFAULT_TERMINAL_OPTIONS,
				type: "integrated",
				useWin32Conhost: true,
			},
			invalid: {
				type: "invalid",
			},
		})

		// eslint-disable-next-line @typescript-eslint/no-shadow
		export function fix(self0: unknown): Fixed<Profile> {
			const unc = launderUnchecked<Invalid>(self0),
				fixPlatforms = <
					V extends Platforms<Vs[number]>,
					const Vs extends ReadonlyTuple<string>,
				>(
					defaults: V,
					from: Unchecked<V>,
					set: Vs,
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
			return markFixed(self0, ((): DeepWritable<Profile> => {
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
							restoreHistory: fixTyped(
								DEFAULTS[type],
								unc,
								"restoreHistory",
								["boolean"],
							),
							successExitCodes: fixArray(
								DEFAULTS[type],
								unc,
								"successExitCodes",
								["string"],
							),
							terminalOptions: fixTerminalOptions(unc["terminalOptions"]).value,
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
							restoreHistory: fixTyped(
								DEFAULTS[type],
								unc,
								"restoreHistory",
								["boolean"],
							),
							successExitCodes: fixArray(
								DEFAULTS[type],
								unc,
								"successExitCodes",
								["string"],
							),
							terminalOptions: fixTerminalOptions(unc["terminalOptions"]).value,
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
							restoreHistory: fixTyped(
								DEFAULTS[type],
								unc,
								"restoreHistory",
								["boolean"],
							),
							successExitCodes: fixArray(
								DEFAULTS[type],
								unc,
								"successExitCodes",
								["string"],
							),
							terminalOptions: fixTerminalOptions(unc["terminalOptions"]).value,
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
							restoreHistory: fixTyped(
								DEFAULTS[type],
								unc,
								"restoreHistory",
								["boolean"],
							),
							successExitCodes: fixArray(
								DEFAULTS[type],
								unc,
								"successExitCodes",
								["string"],
							),
							terminalOptions: fixTerminalOptions(unc["terminalOptions"]).value,
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

		export type TerminalOptions = DeepReadonly<ITerminalOptions>
		export namespace TerminalOptions {
			export const FONT_WEIGHTS = deepFreeze([
				"100",
				"200",
				"300",
				"400",
				"500",
				"600",
				"700",
				"800",
				"900",
				"bold",
				"normal",
			]) satisfies readonly FontWeight[]
		}
		export function fixTerminalOptions(self0: unknown): Fixed<TerminalOptions> {
			const unc = launderUnchecked<TerminalOptions>(self0)
			return markFixed(self0, omitBy({
				allowProposedApi: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"allowProposedApi",
					["undefined", "boolean"],
				),
				allowTransparency: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"allowTransparency",
					["undefined", "boolean"],
				),
				altClickMovesCursor: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"altClickMovesCursor",
					["undefined", "boolean"],
				),
				convertEol: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"convertEol",
					["undefined", "boolean"],
				),
				cursorBlink: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"cursorBlink",
					["undefined", "boolean"],
				),
				cursorStyle: fixInSet(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"cursorStyle",
					[UNDEFINED, "bar", "block", "underline"],
				),
				cursorWidth: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"cursorWidth",
					["undefined", "number"],
				),
				customGlyphs: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"customGlyphs",
					["undefined", "boolean"],
				),
				disableStdin: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"disableStdin",
					["undefined", "boolean"],
				),
				drawBoldTextInBrightColors: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"drawBoldTextInBrightColors",
					["undefined", "boolean"],
				),
				fastScrollModifier: fixInSet(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"fastScrollModifier",
					[UNDEFINED, "alt", "ctrl", "none", "shift"],
				),
				fastScrollSensitivity: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"fastScrollSensitivity",
					["undefined", "number"],
				),
				fontFamily: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"fontFamily",
					["undefined", "string"],
				),
				fontSize: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"fontSize",
					["undefined", "number"],
				),
				fontWeight: ((): FontWeight | undefined => {
					const ret = fixTyped(
						DEFAULT_TERMINAL_OPTIONS,
						unc,
						"fontWeight",
						["undefined", "number", "string"],
					)
					return typeof ret === "string"
						? fixInSet(
							DEFAULT_TERMINAL_OPTIONS,
							unc,
							"fontWeight",
							TerminalOptions.FONT_WEIGHTS,
						)
						: ret
				})(),
				fontWeightBold: ((): FontWeight | undefined => {
					const ret = fixTyped(
						DEFAULT_TERMINAL_OPTIONS,
						unc,
						"fontWeightBold",
						["undefined", "number", "string"],
					)
					return typeof ret === "string"
						? fixInSet(
							DEFAULT_TERMINAL_OPTIONS,
							unc,
							"fontWeightBold",
							TerminalOptions.FONT_WEIGHTS,
						)
						: ret
				})(),
				letterSpacing: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"letterSpacing",
					["undefined", "number"],
				),
				lineHeight: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"lineHeight",
					["undefined", "number"],
				),
				linkHandler: isUndefined(unc.linkHandler)
					? unc.linkHandler
					: ((): ILinkHandler => {
						const unc2 = launderUnchecked<ILinkHandler>(unc.linkHandler),
							ret = {
								activate: fixTyped(
									DEFAULT_LINK_HANDLER,
									unc2,
									"activate",
									["function"],
								) as LinkHandlerFunc,
								allowNonHttpProtocols: fixTyped(
									DEFAULT_LINK_HANDLER,
									unc2,
									"allowNonHttpProtocols",
									["undefined", "boolean"],
								),
								hover: fixTyped(
									DEFAULT_LINK_HANDLER,
									unc2,
									"hover",
									["undefined", "function"],
								) as LinkHandlerFunc | undefined,
								leave: fixTyped(
									DEFAULT_LINK_HANDLER,
									unc2,
									"leave",
									["undefined", "function"],
								) as LinkHandlerFunc | undefined,
							} satisfies Required<DeepUndefinable<ILinkHandler>>
						return {
							...omitBy(ret, isUndefined),
							activate: ret.activate,
						}
					})(),
				logLevel: fixInSet(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"logLevel",
					[UNDEFINED, "debug", "error", "info", "off", "warn"],
				),
				macOptionClickForcesSelection: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"macOptionClickForcesSelection",
					["undefined", "boolean"],
				),
				macOptionIsMeta: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"macOptionIsMeta",
					["undefined", "boolean"],
				),
				minimumContrastRatio: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"minimumContrastRatio",
					["undefined", "number"],
				),
				overviewRulerWidth: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"overviewRulerWidth",
					["undefined", "number"],
				),
				rightClickSelectsWord: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"rightClickSelectsWord",
					["undefined", "boolean"],
				),
				screenReaderMode: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"screenReaderMode",
					["undefined", "boolean"],
				),
				scrollOnUserInput: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"scrollOnUserInput",
					["undefined", "boolean"],
				),
				scrollSensitivity: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"scrollSensitivity",
					["undefined", "number"],
				),
				scrollback: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"scrollback",
					["undefined", "number"],
				),
				smoothScrollDuration: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"smoothScrollDuration",
					["undefined", "number"],
				),
				tabStopWidth: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"tabStopWidth",
					["undefined", "number"],
				),
				theme: isUndefined(unc.theme)
					? unc.theme
					: ((): ITheme => {
						const unc2 = launderUnchecked<ITheme>(unc.theme),
							ret = {
								background: fixTyped(
									DEFAULT_THEME,
									unc2,
									"background",
									["undefined", "string"],
								),
								black: fixTyped(
									DEFAULT_THEME,
									unc2,
									"black",
									["undefined", "string"],
								),
								blue: fixTyped(
									DEFAULT_THEME,
									unc2,
									"blue",
									["undefined", "string"],
								),
								brightBlack: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightBlack",
									["undefined", "string"],
								),
								brightBlue: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightBlue",
									["undefined", "string"],
								),
								brightCyan: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightCyan",
									["undefined", "string"],
								),
								brightGreen: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightGreen",
									["undefined", "string"],
								),
								brightMagenta: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightMagenta",
									["undefined", "string"],
								),
								brightRed: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightRed",
									["undefined", "string"],
								),
								brightWhite: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightWhite",
									["undefined", "string"],
								),
								brightYellow: fixTyped(
									DEFAULT_THEME,
									unc2,
									"brightYellow",
									["undefined", "string"],
								),
								cursor: fixTyped(
									DEFAULT_THEME,
									unc2,
									"cursor",
									["undefined", "string"],
								),
								cursorAccent: fixTyped(
									DEFAULT_THEME,
									unc2,
									"cursorAccent",
									["undefined", "string"],
								),
								cyan: fixTyped(
									DEFAULT_THEME,
									unc2,
									"cyan",
									["undefined", "string"],
								),
								extendedAnsi: isUndefined(unc2.extendedAnsi) ||
									isHomogenousArray(["string"], unc2.extendedAnsi)
									? unc2.extendedAnsi
									: DEFAULT_THEME.extendedAnsi,
								foreground: fixTyped(
									DEFAULT_THEME,
									unc2,
									"foreground",
									["undefined", "string"],
								),
								green: fixTyped(
									DEFAULT_THEME,
									unc2,
									"green",
									["undefined", "string"],
								),
								magenta: fixTyped(
									DEFAULT_THEME,
									unc2,
									"magenta",
									["undefined", "string"],
								),
								red: fixTyped(
									DEFAULT_THEME,
									unc2,
									"red",
									["undefined", "string"],
								),
								selectionBackground: fixTyped(
									DEFAULT_THEME,
									unc2,
									"selectionBackground",
									["undefined", "string"],
								),
								selectionForeground: fixTyped(
									DEFAULT_THEME,
									unc2,
									"selectionForeground",
									["undefined", "string"],
								),
								selectionInactiveBackground: fixTyped(
									DEFAULT_THEME,
									unc2,
									"selectionInactiveBackground",
									["undefined", "string"],
								),
								white: fixTyped(
									DEFAULT_THEME,
									unc2,
									"white",
									["undefined", "string"],
								),
								yellow: fixTyped(
									DEFAULT_THEME,
									unc2,
									"yellow",
									["undefined", "string"],
								),
							} satisfies Required<DeepUndefinable<ITheme>>
						return omitBy(ret, isUndefined)
					})(),
				windowOptions: isUndefined(unc.windowOptions)
					? unc.windowOptions
					: ((): IWindowOptions => {
						const unc2 = launderUnchecked<IWindowOptions>(unc.windowOptions),
							ret = {
								fullscreenWin: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"fullscreenWin",
									["undefined", "boolean"],
								),
								getCellSizePixels: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getCellSizePixels",
									["undefined", "boolean"],
								),
								getIconTitle: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getIconTitle",
									["undefined", "boolean"],
								),
								getScreenSizeChars: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getScreenSizeChars",
									["undefined", "boolean"],
								),
								getScreenSizePixels: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getScreenSizePixels",
									["undefined", "boolean"],
								),
								getWinPosition: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getWinPosition",
									["undefined", "boolean"],
								),
								getWinSizeChars: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getWinSizeChars",
									["undefined", "boolean"],
								),
								getWinSizePixels: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getWinSizePixels",
									["undefined", "boolean"],
								),
								getWinState: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getWinState",
									["undefined", "boolean"],
								),
								getWinTitle: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"getWinTitle",
									["undefined", "boolean"],
								),
								lowerWin: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"lowerWin",
									["undefined", "boolean"],
								),
								maximizeWin: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"maximizeWin",
									["undefined", "boolean"],
								),
								minimizeWin: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"minimizeWin",
									["undefined", "boolean"],
								),
								popTitle: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"popTitle",
									["undefined", "boolean"],
								),
								pushTitle: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"pushTitle",
									["undefined", "boolean"],
								),
								raiseWin: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"raiseWin",
									["undefined", "boolean"],
								),
								refreshWin: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"refreshWin",
									["undefined", "boolean"],
								),
								restoreWin: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"restoreWin",
									["undefined", "boolean"],
								),
								setWinLines: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"setWinLines",
									["undefined", "boolean"],
								),
								setWinPosition: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"setWinPosition",
									["undefined", "boolean"],
								),
								setWinSizeChars: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"setWinSizeChars",
									["undefined", "boolean"],
								),
								setWinSizePixels: fixTyped(
									DEFAULT_WINDOW_OPTIONS,
									unc2,
									"setWinSizePixels",
									["undefined", "boolean"],
								),
							} satisfies Required<DeepUndefinable<IWindowOptions>>
						return omitBy(ret, isUndefined)
					})(),
				windowsMode: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"windowsMode",
					["undefined", "boolean"],
				),
				windowsPty: isUndefined(unc.windowsPty)
					? unc.windowsPty
					: ((): IWindowsPty => {
						const unc2 = launderUnchecked<IWindowsPty>(unc.windowsPty),
							ret = {
								backend: fixInSet(
									DEFAULT_WINDOWS_PTY,
									unc2,
									"backend",
									[UNDEFINED, "conpty", "winpty"],
								),
								buildNumber: fixTyped(
									DEFAULT_WINDOWS_PTY,
									unc2,
									"buildNumber",
									["undefined", "number"],
								),
							} satisfies Required<DeepUndefinable<IWindowsPty>>
						return omitBy(ret, isUndefined)
					})(),
				wordSeparator: fixTyped(
					DEFAULT_TERMINAL_OPTIONS,
					unc,
					"wordSeparator",
					["undefined", "string"],
				),
			} satisfies Required<DeepUndefinable<TerminalOptions>>, isUndefined))
		}
	}
	export function fix(self0: unknown): Fixed<Settings> {
		const unc = launderUnchecked<Settings>(self0)
		return markFixed(self0, {
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
			createInstanceNearExistingOnes: fixTyped(
				DEFAULT,
				unc,
				"createInstanceNearExistingOnes",
				["boolean"],
			),
			errorNoticeTimeout: fixTyped(
				DEFAULT,
				unc,
				"errorNoticeTimeout",
				["number"],
			),
			focusOnNewInstance: fixTyped(
				DEFAULT,
				unc,
				"focusOnNewInstance",
				["boolean"],
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
			newInstanceBehavior: fixInSet(
				DEFAULT,
				unc,
				"newInstanceBehavior",
				NEW_INSTANCE_BEHAVIORS,
			),
			noticeTimeout: fixTyped(
				DEFAULT,
				unc,
				"noticeTimeout",
				["number"],
			),
			openChangelogOnUpdate: fixTyped(
				DEFAULT,
				unc,
				"openChangelogOnUpdate",
				["boolean"],
			),
			pinNewInstance: fixTyped(
				DEFAULT,
				unc,
				"pinNewInstance",
				["boolean"],
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
				if (typeof profiles === "object" && profiles) {
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
