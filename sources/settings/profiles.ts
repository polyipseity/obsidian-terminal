import { DISABLED_TOOLTIP, JSON_STRINGIFY_SPACE } from "sources/magic"
import { EditableListModal, ListModal } from "./modals"
import {
	cloneAsMutable,
	insertAt,
	length,
	removeAt,
	swap,
} from "sources/utils/util"
import { linkSetting, resetButton, setTextToEnum } from "./util"
import type { DeepWritable } from "ts-essentials"
import { PROFILE_PRESETS } from "./profile-presets"
import { Pseudoterminal } from "sources/terminal/pseudoterminal"
import { Setting } from "obsidian"
import { Settings } from "./data"
import type { TerminalPlugin } from "sources/main"

export class ProfileModal extends ListModal {
	readonly #displayFinally: (() => void)[] = []

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly id: string,
	) {
		super(plugin.app)
	}

	public override onOpen(): void {
		super.onOpen()
		this.display()
	}

	public override onClose(): void {
		super.onClose()
		this.#displayFinally.forEach(func => {
			try {
				func()
			} catch (error) {
				console.error(error)
			}
		})
	}

	protected display(): void {
		this.#displayFinally.forEach(func => { func() })
		const { listEl, plugin, id } = this,
			{ settings, language } = plugin,
			{ i18n } = language,
			{ profiles } = settings
		listEl.empty()
		const profile = profiles[id]
		if (typeof profile === "undefined") {
			listEl.createEl("h1", {
				text: i18n.t("settings.profile.not-found", { id }),
			})
			return
		}
		const { name, type } = profile,
			namer = (name0: unknown): string =>
				typeof name0 === "string" ? name0 : ""
		listEl.createEl("h1", {
			text: i18n.t("settings.profile.title", {
				id,
				nameOrID: namer(name) || id,
				profile,
			}),
		}, el => {
			this.#displayFinally.push(plugin.on(
				"mutate-settings",
				settings0 => settings0.profiles[id]?.name,
				cur => {
					el.textContent = i18n.t("settings.profile.title", {
						id,
						nameOrID: namer(cur) || id,
						profile,
					})
				},
			))
		})
		new Setting(listEl)
			.setName(i18n.t("settings.profile.name"))
			.addText(linkSetting(
				plugin,
				() => namer(name),
				async value => this.#mutateProfile(type, profileM => {
					profileM.name = value
				}),
			))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => this.#mutateProfile(type, profileM => {
					profileM.name = Settings.Profile.DEFAULTS[type].name
				}),
				i18n.t("asset:settings.profile.name-icon"),
			))
		new Setting(listEl)
			.setName(i18n.t("settings.profile.type"))
			.addDropdown(linkSetting(
				plugin,
				(): string => type,
				setTextToEnum(
					Settings.Profile.TYPES,
					async value => {
						await this.#mutateProfile(type, (prev, settingsM) => {
							const next = cloneAsMutable(Settings.Profile.DEFAULTS[value])
							next.name = typeof prev.name === "string" ? prev.name : ""
							settingsM.profiles[id] = next
						})
						this.display()
					},
				),
				{
					pre: dropdown => {
						dropdown
							.addOptions(Object
								.fromEntries(Settings.Profile.TYPES
									.filter(type0 => type0 !== "invalid")
									.map(type0 => [type0, i18n.t(`types.profiles.${type0}`)])))
					},
				},
			))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				() => { throw Error() },
				i18n.t("asset:settings.profile.type-icon"),
				{
					post: button => {
						button.setTooltip(DISABLED_TOOLTIP).setDisabled(true)
					},
				},
			))
		switch (type) {
			case "": {
				break
			}
			case "console": {
				break
			}
			case "external": {
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.executable`))
					.addText(linkSetting(
						plugin,
						() => profile.executable,
						async value => this.#mutateProfile(type, profileM => {
							profileM.executable = value
						}),
					))
					.addExtraButton(resetButton(
						plugin,
						this.display.bind(this),
						async () => this.#mutateProfile(type, profileM => {
							profileM.executable = Settings.Profile.DEFAULTS[type].executable
						}),
						i18n.t(`asset:settings.profile.${type}.executable-icon`),
					))
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.arguments`))
					.setDesc(i18n.t("settings.list-description", {
						count: profile.args.length,
					}))
					.addButton(button => button
						.setIcon(i18n
							.t(`asset:settings.profile.${type}.arguments-edit-icon`))
						.setTooltip(i18n.t("settings.edit"))
						.onClick(() => {
							new EditableListModal(
								plugin,
								EditableListModal.stringInputter,
								"",
								profile.args,
								async value => {
									await this.#mutateProfile(type, profileM => {
										profileM.args = cloneAsMutable(value)
									})
									this.#postMutate()
								},
							).open()
						}))
					.addExtraButton(resetButton(
						plugin,
						this.display.bind(this),
						async () => this.#mutateProfile(type, profileM => {
							profileM.args =
								cloneAsMutable(Settings.Profile.DEFAULTS[type].args)
						}),
						i18n.t(`asset:settings.profile.${type}.arguments-icon`),
					))
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					new Setting(listEl)
						.setName(i18n.t(`types.platforms.${platform}`))
						.addToggle(linkSetting(
							plugin,
							() => profile.platforms[platform] ??
								Settings.Profile.DEFAULTS[type].platforms[platform],
							async value => this.#mutateProfile(type, profileM => {
								profileM.platforms[platform] = value
							}),
						))
						.addExtraButton(resetButton(
							plugin,
							this.display.bind(this),
							async () => this.#mutateProfile(type, profileM => {
								profileM.platforms[platform] =
									Settings.Profile.DEFAULTS[type].platforms[platform]
							}),
							i18n.t(`asset:types.platforms.${platform}-icon`),
						))
				}
				break
			}
			case "integrated": {
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.executable`))
					.addText(linkSetting(
						plugin,
						() => profile.executable,
						async value => this.#mutateProfile(type, profileM => {
							profileM.executable = value
						}),
					))
					.addExtraButton(resetButton(
						plugin,
						this.display.bind(this),
						async () => this.#mutateProfile(type, profileM => {
							profileM.executable = Settings.Profile.DEFAULTS[type].executable
						}),
						i18n.t(`asset:settings.profile.${type}.executable-icon`),
					))
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.arguments`))
					.setDesc(i18n.t("settings.list-description", {
						count: profile.args.length,
					}))
					.addButton(button => button
						.setIcon(i18n
							.t(`asset:settings.profile.${type}.arguments-edit-icon`))
						.setTooltip(i18n.t("settings.edit"))
						.onClick(() => {
							new EditableListModal(
								plugin,
								EditableListModal.stringInputter,
								"",
								profile.args,
								async value => {
									await this.#mutateProfile(type, profileM => {
										profileM.args = cloneAsMutable(value)
									})
									this.#postMutate()
								},
							).open()
						}))
					.addExtraButton(resetButton(
						plugin,
						this.display.bind(this),
						async () => this.#mutateProfile(type, profileM => {
							profileM.args =
								cloneAsMutable(Settings.Profile.DEFAULTS[type].args)
						}),
						i18n.t(`asset:settings.profile.${type}.arguments-icon`),
					))
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					new Setting(listEl)
						.setName(i18n.t(`types.platforms.${platform}`))
						.addToggle(linkSetting(
							plugin,
							() => profile.platforms[platform] ??
								Settings.Profile.DEFAULTS[type].platforms[platform],
							async value => this.#mutateProfile(type, profileM => {
								profileM.platforms[platform] = value
							}),
						))
						.addExtraButton(resetButton(
							plugin,
							this.display.bind(this),
							async () => this.#mutateProfile(type, profileM => {
								profileM.platforms[platform] =
									Settings.Profile.DEFAULTS[type].platforms[platform]
							}),
							i18n.t(`asset:types.platforms.${platform}-icon`),
						))
				}
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.python-executable`))
					.setDesc(i18n
						.t(`settings.profile.${type}.python-executable-description`))
					.addText(linkSetting(
						plugin,
						() => profile.pythonExecutable,
						async value => this.#mutateProfile(type, profileM => {
							profileM.pythonExecutable = value
						}),
						{
							post: component => {
								component
									.setPlaceholder(i18n
										// eslint-disable-next-line max-len
										.t(`settings.profile.${type}.python-executable-placeholder`))
							},
						},
					))
					.addExtraButton(resetButton(
						plugin,
						this.display.bind(this),
						async () => this.#mutateProfile(type, profileM => {
							profileM.pythonExecutable =
								Settings.Profile.DEFAULTS[type].pythonExecutable
						}),
						i18n.t(`asset:settings.profile.${type}.python-executable-icon`),
					))
				new Setting(listEl)
					.setName(i18n
						.t(`settings.profile.${type}.enable-Windows-conhost-workaround`))
					.setDesc(i18n
						// eslint-disable-next-line max-len
						.t(`settings.profile.${type}.enable-Windows-conhost-workaround-description`))
					.addToggle(linkSetting(
						plugin,
						() => profile.enableWindowsConhostWorkaround ??
							Settings.Profile.DEFAULTS[type].enableWindowsConhostWorkaround,
						async value => this.#mutateProfile(type, profileM => {
							profileM.enableWindowsConhostWorkaround = value
						}),
					))
					.addExtraButton(resetButton(
						plugin,
						this.display.bind(this),
						async () => this.#mutateProfile(type, profileM => {
							profileM.enableWindowsConhostWorkaround =
								Settings.Profile.DEFAULTS[type].enableWindowsConhostWorkaround
						}),
						i18n
							// eslint-disable-next-line max-len
							.t(`asset:settings.profile.${type}.enable-Windows-conhost-workaround-icon`),
					))
				break
			}
			case "invalid": {
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.data`))
					.addTextArea(textArea => textArea
						.setValue(JSON.stringify(profile, null, JSON_STRINGIFY_SPACE))
						.setDisabled(true))
					.addExtraButton(resetButton(
						plugin,
						this.display.bind(this),
						() => { throw Error() },
						i18n.t(`asset:settings.profile.${type}.data-icon`),
						{
							post: button => {
								button.setTooltip(DISABLED_TOOLTIP).setDisabled(true)
							},
						},
					))
				break
			}
			// No default
		}
	}

	async #mutateProfile<T extends Settings.Profile.Type>(
		type: T,
		mutator: (
			profile: DeepWritable<Settings.Profile> & { type: T },
			settings: DeepWritable<Settings>,
		) => unknown,
	): Promise<void> {
		const { plugin, id } = this
		await plugin.mutateSettings(async settings => {
			const profile = settings.profiles[id]
			if (typeof profile === "undefined") {
				throw new Error(id)
			}
			if (!Settings.Profile.isType(type, profile)) {
				throw new Error(profile.type)
			}
			await mutator(profile, settings)
		})
	}

	#postMutate(): void {
		this.plugin.saveSettings().catch(error => { console.error(error) })
		this.display()
	}
}

export class ProfilesModal extends ListModal {
	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app)
	}

	public override onOpen(): void {
		super.onOpen()
		this.display()
	}

	protected display(): void {
		const { listEl, plugin } = this,
			{ settings, language } = plugin,
			{ i18n } = language,
			{ profiles } = settings
		listEl.empty()
		listEl.createEl("h1", { text: i18n.t("settings.profile-list.title") })
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.prepend"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.prepend-icon"))
				.setTooltip(i18n.t("components.editable-list.prepend"))
				.onClick(async () => {
					await this.#addProfile(0, cloneAsMutable(PROFILE_PRESETS.empty))
					this.#postMutate()
				}))
		for (const [index, [id, profile]] of Object.entries(profiles).entries()) {
			new Setting(listEl)
				.setName(i18n.t("settings.profile-list.name", { profile }))
				.setDesc(i18n.t("settings.profile-list.description", { id, profile }))
				.addButton(button => button
					.setIcon(i18n.t("asset:settings.profile-list.edit-icon"))
					.setTooltip(i18n.t("settings.edit"))
					.onClick(() => {
						const modal = new ProfileModal(plugin, id),
							onClose = modal.onClose.bind(modal)
						modal.onClose = (): void => {
							try {
								onClose()
							} finally {
								try {
									this.display()
								} catch (error) {
									console.error(error)
								}
							}
						}
						modal.open()
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-up"))
					.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
					.onClick(async () => {
						if (index <= 0) { return }
						await this.#mutateProfiles(profilesM => {
							swap(profilesM, index - 1, index)
						})
						this.#postMutate()
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-down"))
					.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
					.onClick(async () => {
						if (index >= length(profiles) - 1) { return }
						await this.#mutateProfiles(profilesM => {
							swap(profilesM, index, index + 1)
						})
						this.#postMutate()
					}))
				.addExtraButton(button => button
					.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
					.setTooltip(i18n.t("components.editable-list.remove"))
					.onClick(async () => {
						await this.#mutateProfiles(profilesM => {
							removeAt(profilesM, index)
						})
						this.#postMutate()
					}))
		}
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.append"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.append-icon"))
				.setTooltip(i18n.t("components.editable-list.append"))
				.onClick(async () => {
					await this.#addProfile(
						length(profiles),
						cloneAsMutable(PROFILE_PRESETS.empty),
					)
					this.#postMutate()
				}))
	}

	#postMutate(): void {
		this.plugin.saveSettings().catch(error => { console.error(error) })
		this.display()
	}

	async #mutateProfiles(mutator: (
		profiles: [string, DeepWritable<Settings.Profile>][],
		profilesView: Settings.Profiles,
		settings: DeepWritable<Settings>,
	) => void): Promise<void> {
		const { plugin } = this
		await plugin.mutateSettings(settings => {
			const profiles = Object.entries(settings.profiles)
			mutator(profiles, settings.profiles, settings)
			settings.profiles = Object.fromEntries(profiles)
		})
	}

	async #addProfile(
		index: number,
		profile: DeepWritable<Settings.Profile>,
	): Promise<void> {
		await this.#mutateProfiles((profiles, view) => {
			let key = crypto.randomUUID()
			while (key in view) { key = crypto.randomUUID() }
			insertAt(profiles, index, [key, profile])
		})
	}
}
