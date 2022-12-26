import { Notice } from "obsidian"

export function notice(
	message: DocumentFragment | string,
	timeout?: number,
): void {
	new Notice("", timeout).setMessage(message)
}
