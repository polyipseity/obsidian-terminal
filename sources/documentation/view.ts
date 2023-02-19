import { type Fixed, fixTyped, markFixed } from "sources/ui/fixers"
import {
	MarkdownView,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import {
	UnnamespacedID,
	readStateCollabratively,
	updateDisplayText,
	writeStateCollabratively,
} from "sources/utils/obsidian"
import type { TerminalPlugin } from "sources/main"
import { deepFreeze } from "sources/utils/util"
import { launderUnchecked } from "sources/utils/types"

export class DocumentationMarkdownView extends MarkdownView {
	public static readonly type = new UnnamespacedID("documentation")
	static #namespacedType: string
	protected state = DocumentationMarkdownView.State.DEFAULT

	public constructor(
		protected readonly plugin: TerminalPlugin,
		leaf: WorkspaceLeaf,
	) {
		DocumentationMarkdownView.#namespacedType =
			DocumentationMarkdownView.type.namespaced(plugin)
		super(leaf)
		this.allowNoFile = true
	}

	public override getViewType(): string {
		return DocumentationMarkdownView.#namespacedType
	}

	public override getDisplayText(): string {
		const { plugin, state } = this,
			{ displayTextI18nKey } = state
		return displayTextI18nKey === null
			? super.getDisplayText()
			: plugin.language.i18n.t(displayTextI18nKey as any)
	}

	public override getIcon(): string {
		const { plugin, state } = this,
			{ iconI18nKey } = state
		return iconI18nKey === null
			? super.getIcon()
			: plugin.language.i18n.t(iconI18nKey as any)
	}

	public override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		const { plugin, app } = this,
			ownState = readStateCollabratively(
				DocumentationMarkdownView.type.namespaced(plugin),
				state,
			),
			{ value, valid } = DocumentationMarkdownView.State.fix(ownState)
		if (!valid) {
			await app.workspace.getLeaf("tab").setViewState({
				state,
				type: super.getViewType(),
			})
			return
		}
		await super.setState(state, result)
		this.state = value
		updateDisplayText(this, app.workspace)
		this.setViewData(value.data, true)
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
		const { plugin, app } = this
		this.register(plugin.language.onChangeLanguage.listen(() => {
			updateDisplayText(this, app.workspace)
		}))
	}
}
export namespace DocumentationMarkdownView {
	export interface State {
		readonly data: string
		readonly displayTextI18nKey: string | null
		readonly iconI18nKey: string | null
	}
	export namespace State {
		export const DEFAULT: State = deepFreeze({
			data: "",
			displayTextI18nKey: null,
			iconI18nKey: null,
		} as const)
		export function fix(self: unknown): Fixed<State> {
			const unc = launderUnchecked<State>(self)
			return markFixed(self, {
				data: fixTyped(DEFAULT, unc, "data", ["string"]),
				displayTextI18nKey: fixTyped(
					DEFAULT,
					unc,
					"displayTextI18nKey",
					["string", "null"],
				),
				iconI18nKey: fixTyped(
					DEFAULT,
					unc,
					"iconI18nKey",
					["string", "null"],
				),
			})
		}
	}
}
