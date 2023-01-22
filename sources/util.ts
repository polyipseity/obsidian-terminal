import { BUNDLE, BUNDLE_KEYS } from "./bundle"
import { Notice, Plugin, type PluginManifest, type View } from "obsidian"
import type { ChildProcess } from "node:child_process"
import { NOTICE_NO_TIMEOUT } from "./magic"
import type { TerminalPlugin } from "./main"
import type { Writable } from "node:stream"

export type Immutable<T> = { readonly [key in keyof T]: Immutable<T[key]> }
export type Mutable<T> = { -readonly [key in keyof T]: Mutable<T[key]> }

export const PLATFORMS =
	["android", "darwin", "ios", "linux", "unknown", "win32"] as const
export type Platform = typeof PLATFORMS[number]
export const DESKTOP_PLATFORMS = ["darwin", "linux", "win32"] as const
export const PLATFORM = ((): Platform => {
	const { userAgent } = navigator
	if (userAgent.includes("like Mac")) {
		return "ios"
	}
	if (userAgent.includes("Android")) {
		return "android"
	}
	if (userAgent.includes("Mac")) {
		return "darwin"
	}
	if (userAgent.includes("Win")) {
		return "win32"
	}
	if (userAgent.includes("Linux") || userAgent.includes("X11")) {
		return "linux"
	}
	return "unknown"
})()

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin
			? plugin.manifest
			: plugin).id}:${this.id}`
	}
}

export function anyToError(obj: any): Error {
	return obj instanceof Error ? obj : new Error(String(obj))
}

export function basename(path: string, ext = ""): string {
	const ret = path.substring(Math.max(
		path.lastIndexOf("/"),
		path.lastIndexOf("\\"),
	) + 1)
	return ret.endsWith(ext) ? ret.substring(0, ret.length - ext.length) : ret
}

export function commandNamer(
	cmdNamer: () => string,
	pluginNamer: () => string,
	defaultPluginName: string,
	format: string,
): () => string {
	const cmd = cmdNamer()
	return () => format
		.replace(cmd, cmdNamer())
		.replace(defaultPluginName, pluginNamer())
}

export function cloneAsMutable<T>(obj: T): Mutable<T> {
	// `readonly` is fake at runtime
	return structuredClone(obj) as Mutable<T>
}

export function executeParanoidly<T>(callback: (
	resolve: (value: PromiseLike<T> | T) => void,
	reject: (reason?: any) => void,
) => void) {
	return (
		resolve: (value: PromiseLike<T> | T) => void,
		reject: (reason?: any) => void,
	): void => {
		try {
			callback(resolve, reject)
		} catch (error) {
			reject(error)
		}
	}
}

export function extname(path: string): string {
	return basename(path).substring(path.lastIndexOf("."))
}

export function saveFile(
	text: string,
	type = "text/plain; charset=UTF-8;",
	filename = "",
): void {
	const ele = document.createElement("a")
	ele.target = "_blank"
	ele.download = filename
	const url = URL.createObjectURL(new Blob([text], { type }))
	try {
		ele.href = url
		ele.click()
	} finally {
		URL.revokeObjectURL(url)
	}
}

export async function spawnPromise<T extends ChildProcess>(spawn: (

) => Promise<T> | T): Promise<T> {
	const ret = await spawn()
	return new Promise<T>(executeParanoidly((resolve, reject) => {
		ret.once("spawn", () => { resolve(ret) })
			.once("error", reject)
	}))
}

export function typedKeys<T extends number | string | symbol>(obj: {
	readonly [key in T]: any
}): readonly T[] {
	return Object.keys(obj) as T[]
}

export function inSet<T>(set: readonly T[], obj: any): obj is T {
	return (set as readonly any[]).includes(obj)
}

export function isInterface<T extends { readonly __type: T["__type"] }>(
	id: T["__type"],
	obj: any,
): obj is T {
	if (!("__type" in obj)) {
		return false
	}
	// eslint-disable-next-line no-underscore-dangle
	return (obj as { readonly __type: any }).__type === id
}

export async function importIfDesktop<T>(module: string): Promise<T> {
	if (inSet(DESKTOP_PLATFORMS, PLATFORM)) {
		return Promise.resolve().then(() => inSet(BUNDLE_KEYS, module)
			? BUNDLE[module]() as T
			// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
			: require(module) as T)
	}
	throw new TypeError(module)
}

export function notice(
	message: () => DocumentFragment | string,
	timeout: number = NOTICE_NO_TIMEOUT,
	plugin?: TerminalPlugin,
): Notice {
	const timeoutMs = 1000 * Math.max(timeout, 0),
		ret = new Notice(message(), timeoutMs)
	if (typeof plugin === "undefined") {
		return ret
	}
	const unreg = plugin.language.registerUse(() => ret.setMessage(message()))
	try {
		if (timeoutMs === 0) {
			plugin.register(unreg)
		} else {
			window.setTimeout(unreg, timeoutMs)
		}
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
		for (const ent of transient
			? ents.reverse()
			: [ents.last() ?? { isIntersecting: false }]) {
			if (ent.isIntersecting) {
				callback(obsr, element, ent)
				break
			}
		}
	})
	ret.observe(element)
	return ret
}

export function openExternal(url?: URL | string): Window | null {
	return window.open(url, "_blank", "noreferrer")
}

export function printError(
	error: any,
	message = (): string => "",
	plugin?: TerminalPlugin,
): void {
	console.error(`${message()}\n`, error)
	notice(
		error instanceof Error
			? (): string => `${message()}\n${error.name}: ${error.message}`
			: (): string => `${message()}\n${String(error)}`,
		NOTICE_NO_TIMEOUT,
		plugin,
	)
}

export function updateDisplayText(view: View): boolean {
	const type = view.getViewType(),
		text = view.getDisplayText(),
		header = document
			.querySelector(`.workspace-tab-header[data-type="${type}"]`)
	if (header === null) { return false }
	const title = header.querySelector(".workspace-tab-header-inner-title")
	if (title === null) { return false }
	const oldText = title.textContent
	if (oldText === null) { return false }
	title.textContent = text
	header.ariaLabel = text
	document.title = document.title.replace(oldText, text)
	return true
}

export async function writePromise(
	stream: Writable,
	chunk: any,
): Promise<void> {
	return new Promise<void>(executeParanoidly((resolve, reject) => {
		const written = stream.write(chunk, error => {
			if (error) { reject(error) } else if (written) { resolve() }
		})
		if (!written) { stream.once("drain", () => { resolve() }) }
	}))
}
