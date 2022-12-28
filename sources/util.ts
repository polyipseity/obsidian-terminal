import { Notice } from "obsidian"
import { i18n } from "./i18n"

export function notice(
	message: DocumentFragment | string,
	timeout?: number,
): void {
	new Notice("", timeout).setMessage(message)
}

export function printError(
	error: Error,
	message = i18n.t("errors.error"),
): void {
	console.error(`${message}: ${error.name}: ${error.message}${typeof error.stack === "undefined" ? "" : `\n${error.stack}`}`)
	notice(`${message}: ${error.name}: ${error.message}`)
}

export class Debouncer {
	protected timer?: number

	public constructor(public readonly timeout?: number) { }

	public apply(callback: () => any, timeout = this.timeout): void {
		window.clearTimeout(this.timer)
		this.timer = window.setTimeout(callback, timeout)
	}
}
