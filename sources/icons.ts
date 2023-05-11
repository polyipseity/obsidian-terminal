import { type Plugin, getIcon } from "obsidian"
import { UnnamespacedID, addIcon } from "./utils/obsidian"
import { siLinux, siMacos, siWindows } from "simple-icons"
import { createElement } from "lucide"

export function loadIcons(plugin: Plugin): void {
	for (const [key, value] of Object.entries<never>({})) {
		if (getIcon(key)) {
			self.console.warn(key)
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
