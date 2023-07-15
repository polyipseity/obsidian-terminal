import {
	type Fixed,
	NOTICE_NO_TIMEOUT,
	NULL_SEM_VER_STRING,
	type PluginContext,
	type SemVerString,
	cloneAsWritable,
	deepFreeze,
	fixInSet,
	fixTyped,
	launderUnchecked,
	markFixed,
	opaqueOrDefault,
	semVerString,
} from "@polyipseity/obsidian-plugin-library"
import type { MarkOptional } from "ts-essentials"
import { PluginLocales } from "../assets/locales.js"

export interface Settings extends PluginContext.Settings {
	readonly language: Settings.DefaultableLanguage
	readonly openChangelogOnUpdate: boolean

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
		errorNoticeTimeout: NOTICE_NO_TIMEOUT,
		language: "",
		noticeTimeout: 5,
		openChangelogOnUpdate: true,
	})

	export const DEFAULTABLE_LANGUAGES =
		deepFreeze(["", ...PluginLocales.LANGUAGES])
	export type DefaultableLanguage = typeof DEFAULTABLE_LANGUAGES[number]

	export function fix(self0: unknown): Fixed<Settings> {
		const unc = launderUnchecked<Settings>(self0)
		return markFixed(self0, {
			errorNoticeTimeout: fixTyped(
				DEFAULT,
				unc,
				"errorNoticeTimeout",
				["number"],
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
			openChangelogOnUpdate: fixTyped(
				DEFAULT,
				unc,
				"openChangelogOnUpdate",
				["boolean"],
			),
			recovery: Object.fromEntries(Object
				.entries(launderUnchecked(unc.recovery))
				.map(([key, value]) => [key, String(value)])),
		})
	}
}
