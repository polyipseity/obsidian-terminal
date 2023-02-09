import { Modal, Setting, type ValueComponent } from "obsidian"
import type { TerminalPlugin } from "sources/main"
import { removeAt } from "sources/utils/util"

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
			setter: (value: T) => void,
		) => void,
		protected readonly placeholder: T,
		list: readonly T[],
		callback: (list: readonly T[]) => void,
	) {
		super(app)
		this.#inputter = inputter
		this.#list = [...list]
		this.#callback = callback
	}

	public static readonly stringInputter = (
		setting: Setting,
		getter: () => string,
		setter: (value: string) => void,
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

	public override onClose(): void {
		super.onClose()
		try {
			this.#callback(this.#list)
		} catch (error) {
			console.log(error)
		}
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
				.onClick(() => {
					this.#list.unshift(placeholder)
					this.display()
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
				value => { this.#list[index] = value },
			)
			setting.addExtraButton(button => button
				.setTooltip(i18n.t("components.editable-list.remove"))
				.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
				.onClick(() => {
					removeAt(this.#list, index)
					this.display()
				}))
		}
		new Setting(listEl)
			.setName(i18n.t("components.editable-list.append"))
			.addButton(button => button
				.setIcon(i18n.t("asset:components.editable-list.append-icon"))
				.setTooltip(i18n.t("components.editable-list.append"))
				.onClick(() => {
					this.#list.push(placeholder)
					this.display()
				}))
	}
}
