// eslint-disable-next-line @typescript-eslint/no-import-type-side-effects
import "obsidian"

declare module "obsidian" {
	export interface WorkspaceRibbon {
		addRibbonItemButton: (
			id: string,
			icon: string,
			title: string,
			callback: (event: MouseEvent) => unknown,
		) => HTMLElement
		removeRibbonAction: (title: string) => void
	}
}
