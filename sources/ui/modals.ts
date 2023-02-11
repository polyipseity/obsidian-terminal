import { DISABLED_TOOLTIP, JSON_STRINGIFY_SPACE } from "sources/magic"
import { Modal, Setting, type ValueComponent } from "obsidian"
import {
	clearProperties,
	cloneAsMutable,
	removeAt,
	swap,
	typedStructuredClone,
	unexpected,
} from "sources/utils/util"
import { linkSetting, resetButton, setTextToEnum } from "./settings"
import type { DeepWritable } from "ts-essentials"
import { PROFILE_PROPERTIES } from "sources/settings/profile-properties"
import { Pseudoterminal } from "sources/terminal/pseudoterminal"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"

export class ListModal extends Modal {
	#listEl: HTMLElement | null = null

	protected get listEl(): HTMLElement {
		const val = this.#listEl
		if (val === null) { throw new Error() }
		return val
	}

	public override onOpen(): void {
		super.onOpen()
		const { contentEl } = this
		contentEl.empty()
		this.#listEl = contentEl.createEl("div", {
			cls: "vertical-tab-content",
		})
	}
}

export class EditableListModal<T> extends ListModal {
	readonly #callback
	readonly #inputter
	readonly #list

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly inputter: (
			setting: Setting,
			getter: () => T,
			setter: (value: T) => unknown,
		) => void,
		protected readonly placeholder: T,
		list: readonly T[],
		callback: (list: T[]) => unknown,
	) {
		super(app)
		this.#inputter = inputter
		this.#list = [...list]
		this.#callback = callback
	}

	public static readonly stringInputter = (
		setting: Setting,
		getter: () => string,
		setter: (value: string) => unknown,
		input: (
			setting: Setting,
			callback: (component: ValueComponent<string> & {
				readonly onChange: (callback: (value: string) => unknown) => unknown
			}) => unknown,
		) => void = (setting0, callback): void => {
			setting0.addTextArea(callback)
		},
	): void => {
		input(setting, text => text
			.setValue(getter())
			.onChange(setter))
	}

	public override onOpen(): void {
		super.onOpen()
		this.display()
	}

	protected display(): void {
		const { listEl, plugin, placeholder } = this,
			{ i18n } = plugin.language
		listEl.empty()
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.prepend"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.prepend-icon"))
				.setTooltip(i18n.t("components.editable-list.prepend"))
				.onClick(async () => {
					this.#list.unshift(placeholder)
					await this.#postMutate(true)
				}))
		for (const [index, item] of this.#list.entries()) {
			const setting = new Setting(listEl)
				.setName(i18n.t("components.editable-list.name", {
					count: index + 1,
					ordinal: true,
				}))
			this.#inputter(
				setting,
				() => item,
				async value => {
					this.#list[index] = value
					await this.#postMutate()
				},
			)
			setting
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-up"))
					.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
					.onClick(async () => {
						if (index <= 0) { return }
						swap(this.#list, index - 1, index)
						await this.#postMutate(true)
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-down"))
					.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
					.onClick(async () => {
						if (index >= this.#list.length - 1) { return }
						swap(this.#list, index, index + 1)
						await this.#postMutate(true)
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.remove"))
					.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
					.onClick(async () => {
						removeAt(this.#list, index)
						await this.#postMutate(true)
					}))
		}
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.append"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.append-icon"))
				.setTooltip(i18n.t("components.editable-list.append"))
				.onClick(async () => {
					this.#list.push(placeholder)
					await this.#postMutate(true)
				}))
	}

	async #postMutate(redraw = false): Promise<void> {
		const cb = this.#callback(typedStructuredClone(this.#list))
		if (redraw) { this.display() }
		await cb
	}
}

export class ProfileModal extends ListModal {
	readonly #profile: DeepWritable<Settings.Profile>
	readonly #callback

	public constructor(
		protected readonly plugin: TerminalPlugin,
		profile: Settings.Profile,
		callback: (profile: DeepWritable<Settings.Profile>) => unknown,
	) {
		super(plugin.app)
		this.#profile = cloneAsMutable(profile)
		this.#callback = callback
	}

	public override onOpen(): void {
		super.onOpen()
		this.display()
	}

	protected display(): void {
		const { listEl, plugin } = this,
			profile = this.#profile,
			{ type } = profile,
			{ language } = plugin,
			{ i18n } = language
		listEl.empty()
		const title = listEl.createEl("h1", {
			text: i18n.t("settings.profile.title", {
				name: Settings.Profile.name(profile),
				profile,
			}),
		})
		new Setting(listEl)
			.setName(i18n.t("settings.profile.name"))
			.addText(linkSetting(
				() => Settings.Profile.name(profile),
				value => { profile.name = value },
				async value => {
					title.textContent = i18n.t("settings.profile.title", {
						name: value,
						profile,
					})
					await this.#postMutate()
				},
			))
			.addExtraButton(resetButton(
				plugin,
				i18n.t("asset:settings.profile.name-icon"),
				() => { profile.name = Settings.Profile.DEFAULTS[type].name },
				this.#postMutate.bind(this, true),
			))
		new Setting(listEl)
			.setName(i18n.t("settings.profile.type"))
			.addDropdown(linkSetting(
				(): string => type,
				setTextToEnum(
					Settings.Profile.TYPES,
					value => {
						const { name } = this.#profile
						clearProperties(this.#profile)
						Object.assign(
							this.#profile,
							cloneAsMutable(Settings.Profile.DEFAULTS[value]),
							{ name },
						)
					},
				),
				this.#postMutate.bind(this, true),
				{
					pre: dropdown => {
						dropdown
							.addOptions(Object
								.fromEntries(Settings.Profile.TYPES
									.filter(type0 => PROFILE_PROPERTIES[type0].valid)
									.map(type0 => [type0, i18n.t(`types.profiles.${type0}`)])))
					},
				},
			))
			.addExtraButton(resetButton(
				plugin,
				i18n.t("asset:settings.profile.type-icon"),
				unexpected,
				unexpected,
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
						() => profile.executable,
						value => { profile.executable = value },
						this.#postMutate.bind(this, false),
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t(`asset:settings.profile.${type}.executable-icon`),
						() => {
							profile.executable = Settings.Profile.DEFAULTS[type].executable
						},
						this.#postMutate.bind(this, true),
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
									profile.args = value
									await this.#postMutate(true)
								},
							).open()
						}))
					.addExtraButton(resetButton(
						plugin,
						i18n.t(`asset:settings.profile.${type}.arguments-icon`),
						() => {
							profile.args =
								cloneAsMutable(Settings.Profile.DEFAULTS[type].args)
						},
						this.#postMutate.bind(this, true),
					))
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					new Setting(listEl)
						.setName(i18n.t(`types.platforms.${platform}`))
						.addToggle(linkSetting(
							() => profile.platforms[platform] ??
								Settings.Profile.DEFAULTS[type].platforms[platform],
							value => {
								profile.platforms[platform] = value
							},
							this.#postMutate.bind(this, false),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:types.platforms.${platform}-icon`),
							() => {
								profile.platforms[platform] =
									Settings.Profile.DEFAULTS[type].platforms[platform]
							},
							this.#postMutate.bind(this, true),
						))
				}
				break
			}
			case "integrated": {
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.executable`))
					.addText(linkSetting(
						() => profile.executable,
						value => {
							profile.executable = value
						},
						this.#postMutate.bind(this, false),
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t(`asset:settings.profile.${type}.executable-icon`),
						() => {
							profile.executable = Settings.Profile.DEFAULTS[type].executable
						},
						this.#postMutate.bind(this, true),
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
									profile.args = value
									await this.#postMutate(true)
								},
							).open()
						}))
					.addExtraButton(resetButton(
						plugin,
						i18n.t(`asset:settings.profile.${type}.arguments-icon`),
						() => {
							profile.args =
								cloneAsMutable(Settings.Profile.DEFAULTS[type].args)
						},
						this.#postMutate.bind(this, true),
					))
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					new Setting(listEl)
						.setName(i18n.t(`types.platforms.${platform}`))
						.addToggle(linkSetting(
							() => profile.platforms[platform] ??
								Settings.Profile.DEFAULTS[type].platforms[platform],
							value => {
								profile.platforms[platform] = value
							},
							this.#postMutate.bind(this, false),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:types.platforms.${platform}-icon`),
							() => {
								profile.platforms[platform] =
									Settings.Profile.DEFAULTS[type].platforms[platform]
							},
							this.#postMutate.bind(this, true),
						))
				}
				new Setting(listEl)
					.setName(i18n.t(`settings.profile.${type}.python-executable`))
					.setDesc(i18n
						.t(`settings.profile.${type}.python-executable-description`))
					.addText(linkSetting(
						() => profile.pythonExecutable,
						value => {
							profile.pythonExecutable = value
						},
						this.#postMutate.bind(this, false),
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
						i18n.t(`asset:settings.profile.${type}.python-executable-icon`),
						() => {
							profile.pythonExecutable =
								Settings.Profile.DEFAULTS[type].pythonExecutable
						},
						this.#postMutate.bind(this, true),
					))
				new Setting(listEl)
					.setName(i18n
						.t(`settings.profile.${type}.enable-Windows-conhost-workaround`))
					.setDesc(i18n
						// eslint-disable-next-line max-len
						.t(`settings.profile.${type}.enable-Windows-conhost-workaround-description`))
					.addToggle(linkSetting(
						() => profile.enableWindowsConhostWorkaround ??
							Settings.Profile.DEFAULTS[type].enableWindowsConhostWorkaround,
						value => {
							profile.enableWindowsConhostWorkaround = value
						},
						this.#postMutate.bind(this, false),
					))
					.addExtraButton(resetButton(
						plugin,
						i18n
							// eslint-disable-next-line max-len
							.t(`asset:settings.profile.${type}.enable-Windows-conhost-workaround-icon`),
						() => {
							profile.enableWindowsConhostWorkaround =
								Settings.Profile.DEFAULTS[type].enableWindowsConhostWorkaround
						},
						this.#postMutate.bind(this, true),
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
						i18n.t(`asset:settings.profile.${type}.data-icon`),
						unexpected,
						unexpected,
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

	async #postMutate(redraw = false): Promise<void> {
		const cb = this.#callback(typedStructuredClone(this.#profile))
		if (redraw) { this.display() }
		await cb
	}
}