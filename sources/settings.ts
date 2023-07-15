import {
	AdvancedSettingTab,
	closeSetting,
	linkSetting,
	registerSettingsCommands,
	resetButton,
} from "@polyipseity/obsidian-plugin-library"
import type { PLACEHOLDERPlugin } from "./main.js"
import { Settings } from "./settings-data.js"
import type { loadDocumentations } from "./documentations.js"
import semverLt from "semver/functions/lt.js"

export class SettingTab extends AdvancedSettingTab<Settings> {
	public constructor(
		protected override readonly context: PLACEHOLDERPlugin,
		protected readonly docs: loadDocumentations.Loaded,
	) { super(context) }

	protected override onLoad(): void {
		super.onLoad()
		const {
			containerEl,
			context: { language: { i18n }, settings, version },
			docs,
			ui,
		} = this
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
