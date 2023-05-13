import {
	AdvancedSettingTab,
	type Fixed,
	NOTICE_NO_TIMEOUT,
	NULL_SEM_VER_STRING,
	type PluginContext,
	type SemVerString,
	cloneAsWritable,
	closeSetting,
	deepFreeze,
	fixInSet,
	fixTyped,
	launderUnchecked,
	linkSetting,
	markFixed,
	opaqueOrDefault,
	registerSettingsCommands,
	resetButton,
	semVerString,
} from "obsidian-plugin-library"
import type { MarkOptional } from "ts-essentials"
import type { PLACEHOLDERPlugin } from "./main"
import { PluginLocales } from "../assets/locales"
import type { loadDocumentations } from "./documentations"
import semverLt from "semver/functions/lt"

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

export class SettingTab extends AdvancedSettingTab<Settings> {
	public constructor(
		context: PLACEHOLDERPlugin,
		docs: loadDocumentations.Loaded,
	) {
		super(context)
		const { containerEl, ui } = this,
			{ language: { i18n }, settings, version } = context
		this.newTitleWidget()
		this.newDescriptionWidget()
		this.newLanguageWidget(
			Settings.DEFAULTABLE_LANGUAGES,
			language => language
				? i18n.t(`language:${language}`)
				: i18n.t("settings.language-default"),
			Settings.DEFAULT,
		)
		ui.newSetting(containerEl, setting => {
			setting
				.setName(i18n.t("settings.documentation"))
				.addButton(button => button
					.setIcon(i18n.t("asset:settings.documentations.donate-icon"))
					.setTooltip(i18n.t("settings.documentations.donate"))
					.setCta()
					.onClick(() => {
						docs.open("donate")
						closeSetting(containerEl)
					}))
				.addButton(button => button
					.setIcon(i18n.t("asset:settings.documentations.readme-icon"))
					.setTooltip(i18n.t("settings.documentations.readme"))
					.setCta()
					.onClick(() => {
						docs.open("readme")
						closeSetting(containerEl)
					}))
				.addButton(button => {
					button
						.setIcon(i18n.t("asset:settings.documentations.changelog-icon"))
						.setTooltip(i18n.t("settings.documentations.changelog"))
						.onClick(() => {
							docs.open("changelog")
							closeSetting(containerEl)
						})
					if (version === null ||
						semverLt(settings.copy.lastReadChangelogVersion, version)) {
						button.setCta()
					}
				})
		})
		this.newAllSettingsWidget(
			Settings.DEFAULT,
			Settings.fix,
		)
		ui.newSetting(containerEl, setting => {
			setting
				.setName(i18n.t("settings.open-changelog-on-update"))
				.addToggle(linkSetting(
					() => settings.copy.openChangelogOnUpdate,
					async value => settings.mutate(settingsM => {
						settingsM.openChangelogOnUpdate = value
					}),
					() => { this.postMutate() },
				))
				.addExtraButton(resetButton(
					i18n.t("asset:settings.open-changelog-on-update-icon"),
					i18n.t("settings.reset"),
					async () => settings.mutate(settingsM => {
						settingsM.openChangelogOnUpdate =
							Settings.DEFAULT.openChangelogOnUpdate
					}),
					() => { this.postMutate() },
				))
		})
		this.newNoticeTimeoutWidget(Settings.DEFAULT)
	}

	protected override snapshot0(): Partial<Settings> {
		return Settings.persistent(this.context.settings.copy)
	}
}

export function loadSettings(
	context: PLACEHOLDERPlugin,
	docs: loadDocumentations.Loaded,
): void {
	context.addSettingTab(new SettingTab(context, docs))
	registerSettingsCommands(context)
}
