import {
	AdvancedSettingTab,
	cloneAsWritable,
	closeSetting,
	createChildElement,
	linkSetting,
	registerSettingsCommands,
	resetButton,
	setTextToEnum,
} from "@polyipseity/obsidian-plugin-library"
import { ProfileListModal } from "./modals.js"
import { Settings } from "./settings-data.js"
import type { TerminalPlugin } from "./main.js"
import type { loadDocumentations } from "./documentations.js"
import semverLt from "semver/functions/lt.js"
import { size } from "lodash-es"

export class SettingTab extends AdvancedSettingTab<Settings> {
	public constructor(
		protected override readonly context: TerminalPlugin,
		protected readonly docs: loadDocumentations.Loaded,
	) { super(context) }

	protected override onLoad(): void {
		super.onLoad()
		const {
			containerEl,
			context, context: { language: { value: i18n }, settings, version },
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
						semverLt(settings.value.lastReadChangelogVersion, version)) {
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
					() => settings.value.openChangelogOnUpdate,
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
		}).newSetting(containerEl, setting => {
			setting
				.setName(i18n.t("settings.add-to-command"))
				.addToggle(linkSetting(
					() => settings.value.addToCommand,
					async value => settings
						.mutate(settingsM => { settingsM.addToCommand = value }),
					() => { this.postMutate() },
				))
				.addExtraButton(resetButton(
					i18n.t("asset:settings.add-to-command-icon"),
					i18n.t("settings.reset"),
					async () => settings.mutate(settingsM => {
						settingsM.addToCommand = Settings.DEFAULT.addToCommand
					}),
					() => { this.postMutate() },
				))
		})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.add-to-context-menu"))
					.addToggle(linkSetting(
						() => settings.value.addToContextMenu,
						async value => settings.mutate(settingsM => {
							settingsM.addToContextMenu = value
						}),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.add-to-context-menu-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.addToContextMenu = Settings.DEFAULT.addToContextMenu
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.profiles"))
					.setDesc(i18n.t("settings.profiles-description", {
						count: size(settings.value.profiles),
						interpolation: { escapeValue: false },
					}))
					.addButton(button => button
						.setIcon(i18n.t("asset:settings.profiles-edit-icon"))
						.setTooltip(i18n.t("settings.profiles-edit"))
						.onClick(() => {
							new ProfileListModal(
								context,
								Object.entries(settings.value.profiles),
								{
									callback: async (data): Promise<void> => {
										await settings.mutate(settingsM => {
											settingsM.profiles = Object.fromEntries(data)
										})
										this.postMutate()
									},
									description: (): string =>
										i18n.t("settings.profile-list.description"),
								},
							).open()
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.profiles-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.profiles = cloneAsWritable(Settings.DEFAULT.profiles)
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.new-instance-behavior"))
					.addDropdown(linkSetting(
						(): string => settings.value.newInstanceBehavior,
						setTextToEnum(
							Settings.NEW_INSTANCE_BEHAVIORS,
							async value => settings.mutate(settingsM => {
								settingsM.newInstanceBehavior = value
							}),
						),
						() => { this.postMutate() },
						{
							pre: dropdown => {
								dropdown
									.addOptions(Object.fromEntries(Settings.NEW_INSTANCE_BEHAVIORS
										.map(value => [
											value,
											i18n.t(`settings.new-instance-behaviors.${value}`),
										])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.new-instance-behavior-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.newInstanceBehavior =
								Settings.DEFAULT.newInstanceBehavior
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.create-instance-near-existing-ones"))
					.setDesc(i18n
						.t("settings.create-instance-near-existing-ones-description"))
					.addToggle(linkSetting(
						() => settings.value.createInstanceNearExistingOnes,
						async value => settings.mutate(settingsM => {
							settingsM.createInstanceNearExistingOnes = value
						}),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.create-instance-near-existing-ones-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.createInstanceNearExistingOnes =
								Settings.DEFAULT.createInstanceNearExistingOnes
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.focus-on-new-instance"))
					.addToggle(linkSetting(
						() => settings.value.focusOnNewInstance,
						async value => settings.mutate(settingsM => {
							settingsM.focusOnNewInstance = value
						}),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.focus-on-new-instance-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.focusOnNewInstance = Settings.DEFAULT.focusOnNewInstance
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.pin-new-instance"))
					.addToggle(linkSetting(
						() => settings.value.pinNewInstance,
						async value => settings.mutate(settingsM => {
							settingsM.pinNewInstance = value
						}),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.pin-new-instance-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.pinNewInstance = Settings.DEFAULT.pinNewInstance
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.hide-status-bar"))
					.addDropdown(linkSetting(
						(): string => settings.value.hideStatusBar,
						setTextToEnum(
							Settings.HIDE_STATUS_BAR_OPTIONS,
							async value => settings.mutate(settingsM => {
								settingsM.hideStatusBar = value
							}),
						),
						() => { this.postMutate() },
						{
							pre: dropdown => {
								dropdown
									.addOptions(Object
										.fromEntries(Settings.HIDE_STATUS_BAR_OPTIONS
											.map(value => [
												value,
												i18n.t(`settings.hide-status-bar-options.${value}`),
											])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.hide-status-bar-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.hideStatusBar = Settings.DEFAULT.hideStatusBar
						}),
						() => { this.postMutate() },
					))
			})
		this.newNoticeTimeoutWidget(Settings.DEFAULT)
		ui.new(() => createChildElement(containerEl, "h2"), ele => {
			ele.textContent = i18n.t("settings.advanced")
		})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.preferred-renderer"))
					.addDropdown(linkSetting(
						(): string => settings.value.preferredRenderer,
						setTextToEnum(
							Settings.PREFERRED_RENDERER_OPTIONS,
							async value => settings.mutate(settingsM => {
								settingsM.preferredRenderer = value
							}),
						),
						() => { this.postMutate() },
						{
							pre: dropdown => {
								dropdown
									.addOptions(Object
										.fromEntries(Settings.PREFERRED_RENDERER_OPTIONS
											.map(type => [
												type,
												i18n.t("settings.preferred-renderer-options", {
													interpolation: { escapeValue: false },
													type,
												}),
											])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.preferred-renderer-icon"),
						i18n.t("settings.reset"),
						async () => settings.mutate(settingsM => {
							settingsM.preferredRenderer = Settings.DEFAULT.preferredRenderer
						}),
						() => { this.postMutate() },
					))
			})
	}

	protected override snapshot0(): Partial<Settings> {
		return Settings.persistent(this.context.settings.value)
	}
}

export function loadSettings(
	context: TerminalPlugin,
	docs: loadDocumentations.Loaded,
): void {
	context.addSettingTab(new SettingTab(context, docs))
	registerSettingsCommands(context)
}
