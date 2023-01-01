import { Notice, Plugin, type PluginManifest } from "obsidian"
import { NOTICE_NO_TIMEOUT } from "./magic"
import type TerminalPlugin from "./main"

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin ? plugin.manifest : plugin).id}:${this.id}`
	}
}

export function commandNamer(
	cmdNamer: () => string,
	pluginNamer: () => string,
	defaultPluginName: string,
	format: string
): () => string {
	const cmd = cmdNamer()
	return () => format
		.replace(cmd, cmdNamer())
		.replace(defaultPluginName, pluginNamer())
}

export function inSet<T>(set: readonly T[], obj: any): obj is T {
	return set.some(mem => obj === mem)
}

export function isInterface<T extends { __type: T["__type"] }>(id: T["__type"], obj: any): obj is T {
	if (!("__type" in obj)) {
		return false
	}
	// eslint-disable-next-line no-underscore-dangle
	return (obj as { __type: any }).__type === id
}

export function statusBar(callback: (
	element: HTMLDivElement) => any = (): void => { }): HTMLDivElement | null {
	const ret = document.querySelector<HTMLDivElement>(".app-container>div.status-bar")
	if (ret !== null) {
		callback(ret)
	}
	return ret
}

export function notice(
	message: () => DocumentFragment | string,
	timeout?: number,
	plugin?: TerminalPlugin,
): Notice {
	const ret = new Notice("", timeout)
	if (typeof plugin === "undefined") {
		ret.setMessage(message())
		return ret
	}
	const unreg = plugin.language.registerUse(() => ret.setMessage(message()))
	try {
		window.setTimeout(unreg, timeout)
	} catch {
		unreg()
	}
	return ret
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
	message?: () => string,
	plugin?: TerminalPlugin,
): void {
	const message0 = typeof message === "undefined" ? (): string => "" : (): string => `${message()}: `
	if (error instanceof Error) {
		console.error(`${message0()}${error.name}: ${error.message}${typeof error.stack === "undefined" ? "" : `\n${error.stack}`}`)
		notice(() => `${message0()}${error.name}: ${error.message}`, NOTICE_NO_TIMEOUT, plugin)
		return
	}
	console.error(`${message0()}${String(error)}`)
	notice(() => `${message0()}${String(error)}`, NOTICE_NO_TIMEOUT, plugin)
}
