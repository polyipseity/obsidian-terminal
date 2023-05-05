/* eslint-disable @typescript-eslint/no-empty-interface */
import type { Private } from "sources/utils/private"

declare module "obsidian" {
	interface DataAdapter extends Private<$DataAdapter> { }
	interface Scope {
		// eslint-disable-next-line @typescript-eslint/method-signature-style
		register(
			modifiers: readonly Modifier[],
			key: string | null,
			func: KeymapEventListener,
		): KeymapEventHandler
	}
	interface ViewStateResult extends Private<$ViewStateResult> { }
	interface WorkspaceLeaf extends Private<$WorkspaceLeaf> { }
	interface WorkspaceRibbon extends Private<$WorkspaceRibbon> { }
}

interface $DataAdapter {
	readonly fs: {
		readonly open: <T extends Platform.Current>(
			path: T extends Platform.Mobile ? string : never,
		) => T extends Platform.Mobile ? PromiseLike<void> : never
	}
}

interface $ViewStateResult {
	history: boolean
}

interface $WorkspaceLeaf {
	readonly tabHeaderEl: HTMLElement
	readonly tabHeaderInnerIconEl: HTMLElement
	readonly tabHeaderInnerTitleEl: HTMLElement
}

interface $WorkspaceRibbon {
	readonly addRibbonItemButton: (
		id: string,
		icon: string,
		title: string,
		callback: (event: MouseEvent) => unknown,
	) => HTMLElement
	readonly removeRibbonAction: (title: string) => void
}
