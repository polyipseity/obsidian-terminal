import { Modal, Setting, type ValueComponent } from "obsidian"
import { removeAt, swap } from "sources/utils/util"
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
		callback: (list: readonly T[]) => unknown,
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
					await this.#postMutate()
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
						await this.#postMutate()
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.move-down"))
					.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
					.onClick(async () => {
						if (index >= this.#list.length - 1) { return }
						swap(this.#list, index, index + 1)
						await this.#postMutate()
					}))
				.addExtraButton(button => button
					.setTooltip(i18n.t("components.editable-list.remove"))
					.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
					.onClick(async () => {
						removeAt(this.#list, index)
						await this.#postMutate()
					}))
		}
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.append"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.append-icon"))
				.setTooltip(i18n.t("components.editable-list.append"))
				.onClick(async () => {
					this.#list.push(placeholder)
					await this.#postMutate()
				}))
	}

	async #postMutate(): Promise<void> {
		const cb = this.#callback(this.#list)
		this.display()
		await cb
	}
}
