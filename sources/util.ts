import { Notice, Plugin, type PluginManifest } from "obsidian"

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin ? plugin.manifest : plugin).id}:${this.id}`
	}
}

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
	message?: string,
): void {
	const message0 = typeof message === "undefined" ? "" : `${message}: `
	if (error instanceof Error) {
		console.error(`${message0}${error.name}: ${error.message}${typeof error.stack === "undefined" ? "" : `\n${error.stack}`}`)
		notice(`${message0}${error.name}: ${error.message}`)
		return
	}
	console.error(`${message0}${String(error)}`)
	notice(`${message0}${String(error)}`)
}
