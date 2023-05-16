import type { PLACEHOLDERPlugin } from "./main.js"
import { getIcon } from "obsidian"
import { registerLucideIcon } from "obsidian-plugin-library"

export function loadIcons(context: PLACEHOLDERPlugin): void {
	for (const [key, value] of Object.entries<never>({})) {
		if (getIcon(key)) {
			self.console.warn(key)
			continue
		}
		registerLucideIcon(context, key, value)
	}
}
