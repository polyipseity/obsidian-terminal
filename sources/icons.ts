import {
	UnnamespacedID,
	registerIcon,
} from "@polyipseity/obsidian-plugin-library"
import { siLinux, siMacos } from "simple-icons"
import type { TerminalPlugin } from "./main.js"

export function loadIcons(context: TerminalPlugin): void {
	for (const [key, value] of Object.entries({
		linux: siLinux,
		macos: siMacos,
	})) {
		registerIcon(
			context,
			new UnnamespacedID(key).namespaced(context),
			value.svg,
		)
	}
}
