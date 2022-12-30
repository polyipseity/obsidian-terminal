import { Notice, Plugin, type PluginManifest } from "obsidian"

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin ? plugin.manifest : plugin).id}:${this.id}`
	}
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
		const lastEnt = ents.last()
		if (typeof lastEnt === "undefined") {
			return
		}
		const intersect = (transient ? ents.reverse() : [lastEnt])
			.find(ent => ent.isIntersecting)
		if (typeof intersect === "undefined") {
			return
		}
		callback(obsr, element, intersect)
	})
	ret.observe(element)
	return ret
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
