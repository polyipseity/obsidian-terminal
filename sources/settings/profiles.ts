import { ListModal, ProfileModal } from "../ui/modals"
import {
	cloneAsMutable,
	insertAt,
	length,
	removeAt,
	swap,
} from "sources/utils/util"
import type { DeepWritable } from "ts-essentials"
import { PROFILE_PRESETS } from "./profile-presets"
import { Setting } from "obsidian"
import type { Settings } from "./data"
import type { TerminalPlugin } from "sources/main"

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
		listEl.createEl("div", { text: i18n.t("settings.profile-list.content") })
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.prepend"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.prepend-icon"))
				.setTooltip(i18n.t("components.editable-list.prepend"))
				.onClick(async () => {
					await this.#addProfile(0, cloneAsMutable(PROFILE_PRESETS.empty))
					this.#postMutate(true)
				}))
		for (const [index, [id, profile]] of Object.entries(profiles).entries()) {
			new Setting(listEl)
				.setName(i18n.t("settings.profile-list.name", { profile }))
				.setDesc(i18n.t("settings.profile-list.description", { id, profile }))
				.addButton(button => button
					.setIcon(i18n.t("asset:settings.profile-list.edit-icon"))
					.setTooltip(i18n.t("settings.edit"))
					.onClick(() => {
						new ProfileModal(
							plugin,
							profile,
							async profile0 => {
								await this.#mutateProfiles(profilesM => {
									profilesM[index] = [id, profile0]
								})
								this.#postMutate(true)
							},
						).open()
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-up"))
					.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
					.onClick(async () => {
						if (index <= 0) { return }
						await this.#mutateProfiles(profilesM => {
							swap(profilesM, index - 1, index)
						})
						this.#postMutate(true)
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-down"))
					.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
					.onClick(async () => {
						if (index >= length(profiles) - 1) { return }
						await this.#mutateProfiles(profilesM => {
							swap(profilesM, index, index + 1)
						})
						this.#postMutate(true)
					}))
				.addExtraButton(button => button
					.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
					.setTooltip(i18n.t("components.editable-list.remove"))
					.onClick(async () => {
						await this.#mutateProfiles(profilesM => {
							removeAt(profilesM, index)
						})
						this.#postMutate(true)
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
					this.#postMutate(true)
				}))
	}

	#postMutate(redraw = false): void {
		this.plugin.saveSettings().catch(error => { console.error(error) })
		if (redraw) { this.display() }
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
