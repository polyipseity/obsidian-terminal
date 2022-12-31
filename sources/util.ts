import { Notice, Plugin, type PluginManifest } from "obsidian"

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin ? plugin.manifest : plugin).id}:${this.id}`
	}
}

export function isInterface<T extends { __type: T["__type"] }>(id: T["__type"], obj: any): obj is T {
	if (!("__type" in obj)) {
		return false
	}
	// eslint-disable-next-line no-underscore-dangle
	return (obj as { __type: any }).__type === id
}

export function statusBar(callback = (_0: HTMLDivElement): any => {

}): HTMLDivElement | null {
	const ret = document.querySelector<HTMLDivElement>(".app-container>div.status-bar")
	if (ret !== null) {
		callback(ret)
	}
	return ret
}

export function notice(
	message: DocumentFragment | string,
	timeout?: number,
): void {
	// Useless but to avoid triggering ESLint rule "no-new"
	new Notice("", timeout).setMessage(message)
}

export function onVisible<E extends Element>(
	element: E,
	callback: (
		observer: IntersectionObserver,
		element: E,
		entry: IntersectionObserverEntry,
	) => any,
	transient = false,
): IntersectionObserver {
	const ret = new IntersectionObserver((ents, obsr) => {
		(transient
			? ents.reverse()
			: [ents.last() ?? { isIntersecting: false }])
			.some(ent => {
				if (ent.isIntersecting) {
					callback(obsr, element, ent)
					return true
				}
				return false
			})
	})
	ret.observe(element)
	return ret
}

export function openExternal(url?: URL | string): Window | null {
	return window.open(url, "_blank", "noreferrer")
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
