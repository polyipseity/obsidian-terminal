import {
	type Fixed,
	fixInSet,
	fixTyped,
	markFixed,
} from "sources/ui/fixers"
import {
	NULL_SEM_VER_STRING,
	type SemVerString,
	launderUnchecked,
	opaqueOrDefault,
	semVerString,
} from "sources/utils/types"
import {
	cloneAsWritable,
	deepFreeze,
} from "../utils/util"
import { LANGUAGES } from "assets/locales"
import type {
	MarkOptional,
} from "ts-essentials"
import {
	NOTICE_NO_TIMEOUT,
} from "sources/magic"

export interface Settings {
	readonly language: Settings.DefaultableLanguage
	readonly openChangelogOnUpdate: boolean
	readonly noticeTimeout: number
	readonly errorNoticeTimeout: number

	readonly lastReadChangelogVersion: SemVerString
	readonly recovery: Settings.Recovery
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

	export const DEFAULTABLE_LANGUAGES = deepFreeze(["", ...LANGUAGES])
	export type DefaultableLanguage = typeof DEFAULTABLE_LANGUAGES[number]

	export type Recovery = Readonly<Record<string, string>>

	export function fix(self: unknown): Fixed<Settings> {
		const unc = launderUnchecked<Settings>(self)
		return markFixed(self, {
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
