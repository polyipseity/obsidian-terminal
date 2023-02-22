import "obsidian"

declare module "obsidian" {
	interface ViewStateResult {
		history: boolean
	}

	interface WorkspaceLeaf {
		readonly tabHeaderEl: HTMLElement
		readonly tabHeaderInnerIconEl: HTMLElement
		readonly tabHeaderInnerTitleEl: HTMLElement
	}

	interface WorkspaceRibbon {
		readonly addRibbonItemButton: (
			id: string,
			icon: string,
			title: string,
			callback: (event: MouseEvent) => unknown,
		) => HTMLElement
		readonly removeRibbonAction: (title: string) => void
	}
}
