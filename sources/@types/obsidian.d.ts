import "obsidian"
import type { Platform } from "sources/utils/platforms"

declare module "obsidian" {
	interface DataAdapter {
		readonly fs: {
			readonly open: <T extends Platform.Current>(
				path: T extends Platform.Mobile ? string : never,
			) => T extends Platform.Mobile ? PromiseLike<void> : never
		}
	}

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
