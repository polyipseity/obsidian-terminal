import { CaseSensitive, ClipboardPaste, WholeWord, createElement } from "lucide"
import { type Plugin, getIcon } from "obsidian"
import { UnnamespacedID, addIcon } from "./utils/obsidian"
import { siLinux, siMacos, siWindows } from "simple-icons"

export function loadIcons(plugin: Plugin): void {
	for (const [key, value] of Object.entries({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"case-sensitive": CaseSensitive,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"clipboard-paste": ClipboardPaste,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"whole-word": WholeWord,
	})) {
		if (getIcon(key)) {
			console.warn(key)
			continue
		}
		const icon = createElement(value)
		icon.setAttribute("width", "100")
		icon.setAttribute("height", "100")
		plugin.register(addIcon(key, icon.outerHTML))
	}
	for (const [key, value] of Object.entries({
		linux: siLinux,
		macos: siMacos,
		windows: siWindows,
	})) {
		plugin.register(addIcon(
			new UnnamespacedID(key).namespaced(plugin),
			value.svg,
		))
	}
}
