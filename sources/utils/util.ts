import {
	type Debouncer,
	Notice,
	Plugin,
	type PluginManifest,
	type View,
} from "obsidian"
import type { PrimitiveType, TypeofMap } from "./typeof"
import type { ChildProcess } from "node:child_process"
import { NOTICE_NO_TIMEOUT } from "../magic"
import type { TerminalPlugin } from "../main"
import type { Writable } from "node:stream"

export type Immutable<T> = { readonly [key in keyof T]: Immutable<T[key]> }
export type Mutable<T> = { -readonly [key in keyof T]: Mutable<T[key]> }

export const PLATFORMS =
	deepFreeze(["android", "darwin", "ios", "linux", "unknown", "win32"] as const)
export type Platform = typeof PLATFORMS[number]
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

export class EventEmitterLite<A extends readonly unknown[]> {
	#emitter: Promise<unknown> = Promise.resolve()
	readonly #listeners: ((...args: A) => unknown)[] = []

	public async emit(...args: A): Promise<void> {
		await this.#emitter
		const emitted = this.#listeners.map(async list => { await list(...args) })
		this.#emitter = Promise.allSettled(emitted)
		await Promise.all(emitted)
	}

	public listen(listener: (...args: A) => unknown): () => void {
		this.#listeners.push(listener)
		return () => { this.#listeners.remove(listener) }
	}
}

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin
			? plugin.manifest
			: plugin).id}:${this.id}`
	}
}

export function anyToError(obj: unknown): Error {
	return obj instanceof Error ? obj : new Error(String(obj))
}

export function asyncDebounce<
	A extends readonly unknown[],
	R,
>(debouncer: Debouncer<[
	(value: PromiseLike<R> | R) => void,
	(reason?: unknown) => void,
	...A], R>): (...args_0: A) => Promise<R> {
	const promises: {
		readonly resolve: (value: PromiseLike<R> | R) => void
		readonly reject: (reason?: unknown) => void
	}[] = []
	return async (...args: A): Promise<R> =>
		new Promise<R>((resolve, reject) => {
			promises.push({ reject, resolve })
			debouncer(value => {
				for (const promise of promises.splice(0)) {
					promise.resolve(value)
				}
			}, error => {
				for (const promise of promises.splice(0)) {
					promise.reject(error)
				}
			}, ...args)
		})
}

export function basename(path: string, ext = ""): string {
	const ret = path.slice(Math.max(
		path.lastIndexOf("/"),
		path.lastIndexOf("\\"),
	) + 1)
	return ret.endsWith(ext) ? ret.slice(0, ret.length - ext.length) : ret
}

export function capitalize(
	str: string,
	locales?: string[] | string,
): string {
	const cp0 = str.codePointAt(0)
	if (typeof cp0 === "undefined") { return "" }
	const char0 = String.fromCodePoint(cp0)
	return `${char0.toLocaleUpperCase(locales)}${str.slice(char0.length)}`
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
	return typedStructuredClone(obj)
}

export function deepFreeze<T>(obj: T): Immutable<T> {
	if (typeof obj === "object") {
		for (const value of Object.values(obj ?? {})) {
			if (!Object.isFrozen(value)) { deepFreeze(value) }
		}
	}
	return Object.freeze(obj)
}

export function executeParanoidly<T>(callback: (
	resolve: (value: PromiseLike<T> | T) => void,
	reject: (reason?: unknown) => void,
) => void) {
	return (
		resolve: (value: PromiseLike<T> | T) => void,
		reject: (reason?: unknown) => void,
	): void => {
		try {
			callback(resolve, reject)
		} catch (error) {
			reject(error)
		}
	}
}

export function extname(path: string): string {
	const base = basename(path),
		idx = base.lastIndexOf(".")
	return idx === -1 ? "" : base.slice(idx)
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
	readonly [key in T]: unknown
}): readonly T[] {
	return Object.keys(obj) as T[]
}

export function typedStructuredClone<T>(
	value: T,
	transfer?: StructuredSerializeOptions,
): T {
	return structuredClone(value, transfer) as T
}

export function isHomogenousArray<T extends PrimitiveType>(
	type: T,
	value: unknown,
): value is TypeofMap[T][] {
	if (!Array.isArray(value)) { return false }
	return value.every(element => typeof element === type)
}

export function inSet<T>(set: readonly T[], obj: unknown): obj is T {
	return (set as readonly unknown[]).includes(obj)
}

export function isInterface<T extends { readonly __type: T["__type"] }>(
	id: T["__type"],
	obj: unknown,
): obj is T {
	const tmp = {}
	Object.assign(tmp, obj)
	if (!("__type" in tmp)) {
		return false
	}
	// eslint-disable-next-line no-underscore-dangle
	return tmp.__type === id
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
	const unreg = plugin.language.onChangeLanguage
		.listen(() => ret.setMessage(message()))
	try {
		if (timeoutMs === 0) {
			plugin.register(unreg)
		} else {
			window.setTimeout(unreg, timeoutMs)
		}
	} catch (error) {
		console.warn(error)
		unreg()
	}
	return ret
}

export function notice2(
	message: () => DocumentFragment | string,
	timeout: number = NOTICE_NO_TIMEOUT,
	plugin?: TerminalPlugin,
): void {
	if (timeout >= 0) {
		notice(message, timeout, plugin)
	}
}

export function onVisible<E extends Element>(
	element: E,
	callback: (
		observer: IntersectionObserver,
		element: E,
		entry: IntersectionObserverEntry,
	) => unknown,
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
	error: Error,
	message = (): string => "",
	plugin?: TerminalPlugin,
): void {
	console.error(`${message()}\n`, error)
	notice2(
		() => `${message()}\n${error.name}: ${error.message}`,
		plugin?.settings.errorNoticeTimeout ?? NOTICE_NO_TIMEOUT,
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
	chunk: unknown,
): Promise<void> {
	return new Promise<void>(executeParanoidly((resolve, reject) => {
		const written = stream.write(chunk, error => {
			if (error) { reject(error) } else if (written) { resolve() }
		})
		if (!written) { stream.once("drain", resolve) }
	}))
}
