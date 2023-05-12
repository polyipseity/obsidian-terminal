import { type Fixed, fixTyped, markFixed } from "sources/ui/fixers"
import {
	ItemView,
	MarkdownRenderer,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import {
	UnnamespacedID,
	printMalformedData,
	readStateCollabratively,
	recordViewStateHistory,
	updateDisplayText,
	writeStateCollabratively,
} from "sources/utils/obsidian"
import { capitalize, createChildElement, deepFreeze } from "sources/utils/util"
import { DOMClasses } from "sources/magic"
import type { NamespacedTranslationKey } from "sources/i18n"
import type { PLACEHOLDERPlugin } from "sources/main"
import { launderUnchecked } from "sources/utils/types"

export class DocumentationMarkdownView extends ItemView {
	public static readonly type = new UnnamespacedID("documentation")
	static #namespacedType: string
	protected readonly element
	#state = DocumentationMarkdownView.State.DEFAULT

	public constructor(
		protected readonly plugin: PLACEHOLDERPlugin,
		leaf: WorkspaceLeaf,
	) {
		DocumentationMarkdownView.#namespacedType =
			DocumentationMarkdownView.type.namespaced(plugin)
		super(leaf)
		const { contentEl } = this
		this.navigation = true
		this.element = createChildElement(
			createChildElement(contentEl, "div", element => {
				element.classList.add(
					DOMClasses.ALLOW_FOLD_HEADINGS,
					DOMClasses.ALLOW_FOLD_LISTS,
					DOMClasses.IS_READABLE_LINE_WIDTH,
					DOMClasses.MARKDOWN_PREVIEW_VIEW,
					DOMClasses.MARKDOWN_RENDERED,
					DOMClasses.NODE_INSERT_EVENT,
					DOMClasses.SHOW_INDENTATION_GUIDE,
				)
			}),
			"div",
			element => {
				element.classList.add(
					DOMClasses.MARKDOWN_PREVIEW_SECTION,
					DOMClasses.MARKDOWN_PREVIEW_SIZER,
				)
			},
		)
	}

	protected get state(): DocumentationMarkdownView.State {
		return this.#state
	}

	protected set state(value: DocumentationMarkdownView.State) {
		this.#state = value
		updateDisplayText(this.plugin, this)
	}

	public override getViewType(): string {
		return DocumentationMarkdownView.#namespacedType
	}

	public override getDisplayText(): string {
		const {
			plugin: { language: { i18n, language } },
			state: { displayTextI18nKey: key },
		} = this
		return key === null ? "" : capitalize(String(i18n.t(key)), language)
	}

	public override getIcon(): string {
		const {
			plugin: { language: { i18n } },
			state: { iconI18nKey: key },
		} = this
		return key === null ? super.getIcon() : String(i18n.t(key))
	}

	public override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		const { plugin, element } = this,
			ownState = readStateCollabratively(
				DocumentationMarkdownView.type.namespaced(plugin),
				state,
			),
			{ value, valid } = DocumentationMarkdownView.State.fix(ownState)
		if (!valid) { printMalformedData(plugin, ownState, value) }
		await super.setState(state, result)
		const { data } = value
		this.state = value
		await MarkdownRenderer.renderMarkdown(data, element, "", this)
		recordViewStateHistory(plugin, result)
	}

	public override getState(): unknown {
		return writeStateCollabratively(
			super.getState(),
			DocumentationMarkdownView.type.namespaced(this.plugin),
			this.state,
		)
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen()
		const { plugin, plugin: { language: { onChangeLanguage } } } = this
		this.register(onChangeLanguage.listen(() => {
			updateDisplayText(plugin, this)
		}))
	}
}
export namespace DocumentationMarkdownView {
	export interface State {
		readonly data: string
		readonly displayTextI18nKey: NamespacedTranslationKey | null
		readonly iconI18nKey: NamespacedTranslationKey | null
	}
	export namespace State {
		export const DEFAULT: State = deepFreeze({
			data: "",
			displayTextI18nKey: null,
			iconI18nKey: null,
		})
		export function fix(self: unknown): Fixed<State> {
			const unc = launderUnchecked<State>(self)
			return markFixed(self, {
				data: fixTyped(DEFAULT, unc, "data", ["string"]),
				displayTextI18nKey: fixTyped(
					DEFAULT,
					unc,
					"displayTextI18nKey",
					["string", "null"],
				) as NamespacedTranslationKey | null,
				iconI18nKey: fixTyped(
					DEFAULT,
					unc,
					"iconI18nKey",
					["string", "null"],
				) as NamespacedTranslationKey | null,
			})
		}
	}
}
