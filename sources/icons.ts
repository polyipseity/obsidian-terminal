import { type Plugin, getIcon } from "obsidian"
import {
	UnnamespacedID,
	registerIcon,
	registerLucideIcon,
} from "obsidian-plugin-library"
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
			context,
			new UnnamespacedID(key).namespaced(context),
			value.svg,
		)
	}
}
