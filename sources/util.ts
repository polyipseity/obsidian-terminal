import { I18N } from "./i18n"
import { Notice } from "obsidian"

export function notice(
	message: DocumentFragment | string,
	timeout?: number,
): void {
	new Notice("", timeout).setMessage(message)
}

export function onVisible<E extends Element>(
	element: E,
	callback: (
		observer: IntersectionObserver,
		element: E,
		entry: IntersectionObserverEntry,
		entries: IntersectionObserverEntry[],
	) => any,
): void {
	new IntersectionObserver((entries, observer) => {
		for (const entry of entries) {
			if (entry.intersectionRatio > 0) {
				callback(observer, element, entry, entries)
				break
			}
		}
	}).observe(element)
}

export function printError(
	error: any,
	message = I18N.t("errors.error"),
): void {
	if (error instanceof Error) {
		console.error(`${message}: ${error.name}: ${error.message}${typeof error.stack === "undefined" ? "" : `\n${error.stack}`}`)
		notice(`${message}: ${error.name}: ${error.message}`)
		return
	}
	console.error(`${message}: ${String(error)}`)
	notice(`${message}: ${String(error)}`)
}
