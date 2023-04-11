import { ClipboardPaste, createElement } from "lucide"
import { type Plugin, addIcon, getIcon } from "obsidian"
import { siLinux, siMacos, siWindows } from "simple-icons"
import { UnnamespacedID } from "./utils/obsidian"

export function loadIcons(plugin: Plugin): void {
	for (const [key, value] of Object.entries({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"clipboard-paste": ClipboardPaste,
	})) {
		if (!getIcon(key)) {
			const icon = createElement(value)
			icon.setAttribute("width", "100")
			icon.setAttribute("height", "100")
			addIcon(key, icon.outerHTML)
		}
	}
	for (const [key, value] of Object.entries({
		linux: siLinux,
		macos: siMacos,
		windows: siWindows,
	})) {
		addIcon(new UnnamespacedID(key).namespaced(plugin), value.svg)
	}
}
