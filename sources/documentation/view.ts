import {
	type Fixed,
	fixTyped,
	launderUnchecked,
	markFixed,
} from "sources/ui/fixers"
import {
	MarkdownView,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import { UnnamespacedID, printMalformedData } from "sources/utils/obsidian"
import type { TerminalPlugin } from "sources/main"
import { deepFreeze } from "sources/utils/util"

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

	public override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		await super.setState(state, result)
		const { plugin } = this,
			{ value, valid } = DocumentationMarkdownView.State.fix(state)
		if (!valid) { printMalformedData(plugin, state, value) }
		this.state = value
		this.setViewData(value.data, true)
	}

	public override getState(): unknown {
		return Object.assign(super.getState(), this.state)
	}
}
export namespace DocumentationMarkdownView {
	export interface State {
		readonly data: string
	}
	export namespace State {
		export const DEFAULT: State = deepFreeze({ data: "" } as const)
		export function fix(self: unknown): Fixed<State> {
			const unc = launderUnchecked<State>(self)
			return markFixed(self, {
				data: fixTyped(DEFAULT, unc, "data", ["string"]),
			})
		}
	}
}
