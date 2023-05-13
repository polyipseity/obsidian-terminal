import { type Plugin, getIcon } from "obsidian"
import { registerLucideIcon } from "obsidian-plugin-library"

export function loadIcons(context: Plugin): void {
	for (const [key, value] of Object.entries<never>({})) {
		if (getIcon(key)) {
			self.console.warn(key)
			continue
		}
		registerLucideIcon(context, key, value)
	}
}
