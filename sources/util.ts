import { Notice } from "obsidian"

export function notice(
	message: DocumentFragment | string,
	timeout?: number,
): void {
	new Notice("", timeout).setMessage(message)
}

export function printError(
	error: Error,
	message = "Error",
): void {
	console.error(`${message}: ${error.name}: ${error.message}${typeof error.stack === "undefined" ? "" : `\n${error.stack}`}`)
	notice(`${message}: ${error.name}: ${error.message}`)
}
