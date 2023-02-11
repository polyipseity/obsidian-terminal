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
	readonly #data
	readonly #callback
	readonly #keygen

	public constructor(
		protected readonly plugin: TerminalPlugin,
		data: readonly Settings.Profile.Entry[],
		callback: (data_: DeepWritable<typeof data>) => unknown,
		keygen = crypto.randomUUID.bind(crypto),
	) {
		super(plugin.app)
		this.#data = cloneAsMutable(data)
		this.#callback = callback
		this.#keygen = keygen
	}

	public override onOpen(): void {
		super.onOpen()
		this.display()
	}

	protected display(): void {
		const { listEl, plugin } = this,
			{ language } = plugin,
			{ i18n } = language
		listEl.empty()
		listEl.createEl("h1", { text: i18n.t("settings.profile-list.title") })
		listEl.createEl("div", { text: i18n.t("settings.profile-list.content") })
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.prepend"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.prepend-icon"))
				.setTooltip(i18n.t("components.editable-list.prepend"))
				.onClick(async () => {
					this.#addProfile(0, cloneAsMutable(PROFILE_PRESETS.empty))
					await this.#postMutate(true)
				}))
		for (const [index, [id, profile]] of this.#data.entries()) {
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
								this.#data[index] = [id, profile0]
								await this.#postMutate(true)
							},
						).open()
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-up"))
					.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
					.onClick(async () => {
						if (index <= 0) { return }
						swap(this.#data, index - 1, index)
						await this.#postMutate(true)
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-down"))
					.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
					.onClick(async () => {
						if (index >= length(this.#data) - 1) { return }
						swap(this.#data, index, index + 1)
						await this.#postMutate(true)
					}))
				.addExtraButton(button => button
					.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
					.setTooltip(i18n.t("components.editable-list.remove"))
					.onClick(async () => {
						removeAt(this.#data, index)
						await this.#postMutate(true)
					}))
		}
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.append"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.append-icon"))
				.setTooltip(i18n.t("components.editable-list.append"))
				.onClick(async () => {
					this.#addProfile(
						this.#data.length,
						cloneAsMutable(PROFILE_PRESETS.empty),
					)
					await this.#postMutate(true)
				}))
	}

	async #postMutate(redraw = false): Promise<void> {
		const cb = this.#callback(cloneAsMutable(this.#data))
		if (redraw) { this.display() }
		await cb
	}

	#addProfile(
		index: number,
		profile: DeepWritable<Settings.Profile>,
	): void {
		let key = this.#keygen()
		while (this.#data.map(entry => entry[0]).includes(key)) {
			key = this.#keygen()
		}
		insertAt(this.#data, index, [key, profile])
	}
}
