// eslint-disable-next-line @typescript-eslint/no-import-type-side-effects
import "obsidian"

declare module "obsidian" {
	export interface ViewStateResult {
		history: boolean
	}

	export interface WorkspaceLeaf {
		readonly tabHeaderEl: HTMLElement
		readonly tabHeaderInnerIconEl: HTMLElement
		readonly tabHeaderInnerTitleEl: HTMLElement
	}

	export interface WorkspaceRibbon {
		readonly addRibbonItemButton: (
			id: string,
			icon: string,
			title: string,
			callback: (event: MouseEvent) => unknown,
		) => HTMLElement
		readonly removeRibbonAction: (title: string) => void
	}
}
