import { type Plugin, getIcon } from "obsidian"
import { UnnamespacedID, addIcon } from "./utils/obsidian"
import { registerIcon, registerLucideIcon } from "obsidian-plugin-library"
import { siLinux, siMacos, siWindows } from "simple-icons"

export function loadIcons(context: Plugin): void {
	for (const [key, value] of Object.entries<never>({})) {
		if (getIcon(key)) {
			self.console.warn(key)
			continue
		}
		registerLucideIcon(context, key, value)
	}
	for (const [key, value] of Object.entries({
		linux: siLinux,
		macos: siMacos,
		windows: siWindows,
	})) {
		registerIcon(
			plugin,
			new UnnamespacedID(key).namespaced(plugin),
			value.svg,
		)
	}
}
