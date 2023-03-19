import {
	check_outros as $checkOutros,
	group_outros as $groupOutros,
	transition_out as $transitionOut,
} from "svelte/internal"
import type { AsyncOrSync, DeepReadonly, DeepWritable } from "ts-essentials"
import {
	type CodePoint,
	type Constructor,
	type Contains,
	type Sized,
	simplifyType,
} from "./types"
import {
	JSON_STRINGIFY_SPACE,
	MAX_LOCK_PENDING,
	SI_PREFIX_SCALE,
	UNDEFINED,
} from "sources/magic"
import {
	type PrimitiveTypeE,
	type TypeofMapE,
	genericTypeofGuardE,
} from "./typeof"
import { escapeRegExp, isEmpty, isUndefined, noop, range } from "lodash-es"
import AsyncLock from "async-lock"
import type { ChildProcess } from "node:child_process"
import type { SvelteComponent } from "svelte"
import type { Writable } from "node:stream"
import { getSerialize } from "json-stringify-safe"

export type KeyModifier = "Alt" | "Ctrl" | "Meta" | "Shift"
export const EMPTY_OBJECT: Readonly<Record<number | string | symbol, never>> =
	deepFreeze({})
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
	protected static readonly emitLock = "emit"
	protected readonly lock = new AsyncLock({ maxPending: MAX_LOCK_PENDING })
	readonly #listeners: ((...args: A) => unknown)[] = []

	public async emit(...args: A): Promise<void> {
		return new Promise((resolve, reject) => {
			this.lock.acquire(EventEmitterLite.emitLock, async () => {
				const emitted = this.#listeners
					.map(async list => { await list(...args) })
				resolve(Promise.all(emitted).then(noop))
				await Promise.allSettled(emitted)
			}).catch(reject)
		})
	}

	public listen(listener: (...args: A) => unknown): () => void {
		this.#listeners.push(listener)
		return () => { remove(this.#listeners, listener) }
	}
}

export class Functions<
	Async extends boolean = false,
	Args extends readonly unknown[] = [],
> extends Array<
	Async extends true ? (
		...args: Args
	) => unknown : Async extends false ? (
		...args: Args
	) => void : never> {
	public constructor(
		protected readonly options: {
			readonly async: Async
			readonly settled?: boolean
		},
		...args: readonly (Async extends true ? (
			...args: Args
		) => unknown : Async extends false ? (
			...args: Args
		) => void : never)[]
	) {
		super(...args)
	}

	public transform(func: (
		self: this[number][],
	) => readonly this[number][]): Functions<Async, Args> {
		return new Functions(this.options, ...func(this))
	}

	public call(...args: Args): Async extends true
		// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
		? Promise<void> : Async extends false ? void : never {
		return this.call0(null, ...args)
	}

	public call0(
		thisArg: unknown,
		...args: Args
	): Async extends true
		// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
		? Promise<void> : Async extends false ? void : never
	public call0(thisArg: unknown, ...args: Args): AsyncOrSync<void> {
		const { async, settled } = this.options
		if (async) {
			return (async (): Promise<void> => {
				const promises = this.map(async func => {
					await func.call(thisArg, ...args)
				})
				if (settled ?? false) {
					await Promise.allSettled(promises)
					return
				}
				await Promise.all(promises)
			})()
		}
		this.forEach(settled ?? false
			? (func): void => {
				try {
					func.call(thisArg, ...args)
				} catch (error) {
					console.error(error)
				}
			}
			: (func): void => { func.call(thisArg, ...args) })
		return UNDEFINED
	}
}

export async function acquireConditionally<T>(
	lock: AsyncLock,
	key: string[] | string,
	condition: boolean,
	fn: () => PromiseLike<T> | T,
): Promise<T> {
	return condition ? lock.acquire(key, fn) : fn()
}

export function anyToError(obj: unknown): Error {
	return obj instanceof Error ? obj : new Error(String(obj))
}

export function basename(path: string, ext = ""): string {
	const ret = path.slice(Math.max(
		path.lastIndexOf("/"),
		path.lastIndexOf("\\"),
	) + 1)
	return ret.endsWith(ext) ? ret.slice(0, ret.length - ext.length) : ret
}

export function bigIntReplacer(): (key: string, value: unknown) => unknown {
	return (_0, value) => {
		if (typeof value === "bigint") {
			return value.toString()
		}
		return value
	}
}

export function bracket<T>(self: readonly T[], index: number): {
	readonly valid: false
	readonly value?: never
} | {
	readonly valid: true
	readonly value: T
} {
	return Object.freeze(index in self
		? { valid: true, value: self[index] as T }
		: { valid: false })
}

export function capitalize(
	str: string,
	locales?: string[] | string,
): string {
	return mapFirstCodePoint(first => first.toLocaleUpperCase(locales), str)
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function cartesianProduct<T extends readonly (readonly unknown[])[],
>(...arrays: T) {
	return deepFreeze(arrays.reduce((acc, arr) => acc
		.flatMap(comb => arr.map(ele => [comb, ele].flat())), [[]])) as
		readonly ({ readonly [I in keyof T]: T[I][number] } &
		{ readonly length: T["length"] })[]
}

export function clear(self: unknown[]): void {
	self.length = 0
}

export function clearProperties(self: object): void {
	for (const key of Reflect.ownKeys(self)) {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete self[key as keyof typeof self]
	}
}

export function cloneAsWritable<T>(obj: T): DeepWritable<T> {
	// `readonly` is fake at runtime
	return typedStructuredClone(obj) as DeepWritable<T>
}

export function consumeEvent(event: Event): void {
	event.preventDefault()
	event.stopPropagation()
}

export function copyOnWrite<T extends object>(
	obj: DeepReadonly<T>,
	mutator: (obj: DeepWritable<T>) => void,
): DeepReadonly<T> {
	const ret = simplifyType(cloneAsWritable(obj))
	mutator(ret)
	return simplifyType(deepFreeze(ret))
}

export async function copyOnWriteAsync<T extends object>(
	obj: DeepReadonly<T>,
	mutator: (obj: DeepWritable<T>) => unknown,
): Promise<DeepReadonly<T>> {
	const ret = simplifyType(cloneAsWritable(obj))
	await mutator(ret)
	return simplifyType(deepFreeze(ret))
}

export function createChildElement<K extends keyof HTMLElementTagNameMap>(
	element: HTMLElement,
	type: K,
	callback = (_element: HTMLElementTagNameMap[K]): void => { },
	options?: ElementCreationOptions,
): HTMLElementTagNameMap[K] {
	const ret = element.ownerDocument.createElement(type, options)
	element.append(ret)
	callback(ret)
	return ret
}

export function deepFreeze<T>(value: T): DeepReadonly<T> {
	return deepFreeze0(value, new WeakSet())
}
function deepFreeze0<T>(value: T, freezing: WeakSet<object>): DeepReadonly<T> {
	if (typeof value === "object" && value) {
		freezing.add(value)
		for (const subkey of Reflect.ownKeys(value)) {
			const subvalue = value[subkey as keyof typeof value]
			if ((typeof subvalue === "object" || typeof subvalue === "function") &&
				subvalue &&
				!freezing.has(subvalue)) {
				deepFreeze0(subvalue, freezing)
			}
		}
	}
	return Object.freeze(value) as DeepReadonly<T>
}

// Feature request: https://github.com/sveltejs/svelte/issues/4056
export function destroyWithOutro(self: SvelteComponent): void {
	const { $$: { fragment } } = self
	if (fragment !== false && fragment) {
		try {
			$groupOutros()
			$transitionOut(fragment, 0, 0, () => { self.$destroy() })
			$checkOutros()
		} catch (error) {
			console.error(error)
			self.$destroy()
		}
	} else {
		self.$destroy()
	}
}

export function escapeQuerySelectorAttribute(value: string): string {
	return multireplace(value, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"\"": "\\\"",
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"\\": "\\\\",
	})
}

export function extname(path: string): string {
	const base = basename(path),
		idx = base.lastIndexOf(".")
	return idx === -1 ? "" : base.slice(idx)
}

export function getKeyModifiers(
	event: KeyboardEvent,
): readonly KeyModifier[] {
	const ret: KeyModifier[] = []
	if (event.altKey) { ret.push("Alt") }
	if (event.ctrlKey) { ret.push("Ctrl") }
	if (event.metaKey) { ret.push("Meta") }
	if (event.shiftKey) { ret.push("Shift") }
	return deepFreeze(ret)
}

export async function spawnPromise<T extends ChildProcess>(spawn: (

) => AsyncOrSync<T>): Promise<T> {
	const ret = await spawn()
	return new Promise<T>((resolve, reject) => {
		ret.once("spawn", () => { resolve(ret) })
			.once("error", reject)
	})
}

export function typedKeys<T extends readonly (number | string | symbol)[]>() {
	return <O extends (keyof O extends T[number] ? {
		readonly [_ in T[number]]: unknown
	} : never)>(obj: O): Readonly<T> =>
		deepFreeze(Object.keys(obj)) as T
}

export function typedStructuredClone<T>(
	value: T,
	transfer?: StructuredSerializeOptions,
): T {
	return structuredClone(value, transfer) as T
}

export function inSet<T extends readonly unknown[]>(
	set: Sized<T>,
	obj: unknown,
): obj is T[number] {
	return set.includes(obj)
}

export function insertAt<T>(
	self: T[],
	index: number,
	...items: readonly T[]
): void {
	self.splice(index, 0, ...items)
}

export function instanceOf<T extends Node | UIEvent>(
	self: Node | UIEvent | null | undefined,
	type: Constructor<T>,
): self is T {
	if (!self) { return false }
	if (self instanceof type) { return true }
	const { name } = type,
		typeMain: unknown = Reflect.get(window, name)
	if (typeMain instanceof Function && self instanceof typeMain) { return true }
	const
		win = "ownerDocument" in self
			? self.ownerDocument?.defaultView
			: self.view,
		typeWin: unknown = win ? Reflect.get(win, name) : null
	if (typeWin instanceof Function && self instanceof typeWin) { return true }
	return false
}

export function isHomogenousArray<T extends PrimitiveTypeE>(
	types: readonly T[],
	value: unknown,
): value is TypeofMapE[T][] {
	if (!Array.isArray(value)) { return false }
	return value.every(element => genericTypeofGuardE(types, element))
}

export function isNonNullish<T>(value: Contains<T, null | undefined
> extends true ? T : never): value is Contains<T, null | undefined
> extends true ? NonNullable<T> : never {
	return !isNullish(value)
}

export function isNullish<T>(value: Contains<T, null | undefined
> extends true ? T : never): value is
	Contains<T, null | undefined
	> extends true ? T & null | T & undefined : never {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	return value === null || typeof value === "undefined"
}

export function lazyInit<T>(initializer: () => T): () => T {
	let cache: {
		readonly init: false
		readonly value: null
	} | {
		readonly init: true
		readonly value: T
	} = deepFreeze({ init: false, value: null })
	return () => {
		const cache0 = cache.init
			? cache
			: cache = Object.freeze({ init: true, value: initializer() })
		return cache0.value
	}
}

export function logError(thing: unknown): void {
	console.error(thing)
}

export function logFormat(...args: readonly unknown[]): string {
	if (isEmpty(args)) { return "" }
	const
		stringify0 = (param: unknown): string => {
			if (typeof param === "object" && typeof param !== "function") {
				try {
					return JSON.stringify(
						param,
						getSerialize(bigIntReplacer()),
						JSON_STRINGIFY_SPACE,
					)
				} catch {
					// NOOP
				}
			}
			return String(param)
		},
		[format, ...rest] = args
	if (typeof format === "string") {
		return [
			...(function* fn(): Generator<string, void> {
				const params = rest[Symbol.iterator]()
				let back = 0
				for (let sub = format.indexOf("%");
					sub !== -1;
					sub = format.indexOf("%", back)) {
					yield format.slice(back, sub)
					back = sub + "%".length
					const type = format.codePointAt(back)
					if (isUndefined(type)) {
						yield "%"
						continue
					}
					const type0 = String.fromCodePoint(type)
					back += type0.length
					let func: ((param: unknown) => string) | null = null
					switch (type0) {
						case "%":
							yield "%%"
							break
						case "s":
							func = (param): string => String(param)
							break
						case "o":
						case "O":
							func = stringify0
							break
						case "f":
							func = (param): string => Number(param).toString()
							break
						case "d":
						case "i":
							func = (param): string => Math.trunc(Number(param)).toString()
							break
						case "c":
							// CSS unsupported
							func = (): string => ""
							break
						default:
							yield `%${type0}`
							break
					}
					if (func) {
						const param = params.next()
						if (param.done ?? false) {
							yield `%${type0}`
							break
						}
						yield func(param.value)
					}
				}
				yield format.slice(back)
				for (const param of params) {
					yield ` ${stringify0(param)}`
				}
			}()),
		].join("")
	}
	return args.map(stringify0).join(" ")
}

export function logWarn(thing: unknown): void {
	console.warn(thing)
}

export function mapFirstCodePoint(
	map: (value: string) => string,
	str: string,
): string {
	const cp0 = str.codePointAt(0)
	if (isUndefined(cp0)) { return "" }
	const char0 = String.fromCodePoint(cp0)
	return `${map(char0)}${str.slice(char0.length)}`
}

export function multireplace(
	self: string,
	replacements: Readonly<Record<string, string>>,
): string {
	return self.replace(new RegExp(
		Object.keys(replacements)
			.map(escapeRegExp)
			.join("|"),
		"ug",
	), match => replacements[match] ?? match)
}

export function onResize(
	element: Element,
	callback: (entry: ResizeObserverEntry) => unknown,
): ResizeObserver | null {
	const view = element.ownerDocument.defaultView
	if (!view) { return null }
	const ret = new view.ResizeObserver(ents => {
		const ent = ents.at(-1)
		if (ent) { callback(ent) }
	})
	ret.observe(element)
	return ret
}

export function onVisible(
	element: Element,
	callback: (entry: IntersectionObserverEntry) => unknown,
	transient = false,
): IntersectionObserver | null {
	const view = element.ownerDocument.defaultView
	if (!view) { return null }
	const ret = new view.IntersectionObserver(ents => {
		for (const ent of transient
			? ents.reverse()
			: [ents.at(-1) ?? { isIntersecting: false }]) {
			if (ent.isIntersecting) {
				callback(ent)
				break
			}
		}
	})
	ret.observe(element)
	return ret
}

export async function promisePromise<T>(): Promise<{
	readonly promise: Promise<T>
	readonly resolve: (value: AsyncOrSync<T>) => void
	readonly reject: (reason?: unknown) => void
}> {
	return new Promise(resolve0 => {
		const promise = new Promise<T>((resolve, reject) => {
			resolve0(Promise.resolve()
				.then(() => ({ promise, reject, resolve })))
		})
	})
}

export function randomNotIn(
	self: readonly string[],
	generator = (): string => crypto.randomUUID(),
): string {
	let ret = generator()
	while (self.includes(ret)) { ret = generator() }
	return ret
}

export function rangeCodePoint(
	start: CodePoint,
	end?: CodePoint,
	step?: number,
): readonly string[] {
	return deepFreeze(
		range(start.codePointAt(0), end?.codePointAt(0), step)
			.map(cp => String.fromCodePoint(cp)),
	)
}

export function remove<T>(self: T[], item: T): T | undefined {
	return removeAt(self, self.indexOf(item))
}

export function removeAt<T>(self: T[], index: number): T | undefined {
	return self.splice(index, 1)[0]
}

export function replaceAllRegex(string: string): RegExp {
	return new RegExp(escapeRegExp(string), "ug")
}

export async function sleep2(timeInSeconds: number): Promise<void> {
	return new Promise(resolve => {
		self.setTimeout(resolve, timeInSeconds * SI_PREFIX_SCALE)
	})
}

export function swap(self: unknown[], left: number, right: number): void {
	[self[left], self[right]] = [self[right], self[left]]
}

export function uncapitalize(
	str: string,
	locales?: string[] | string,
): string {
	return mapFirstCodePoint(first => first.toLocaleLowerCase(locales), str)
}

export function unexpected(): never {
	throw new Error()
}

export async function writePromise(
	stream: Writable,
	chunk: unknown,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const written = stream.write(chunk, error => {
			if (error) { reject(error) } else if (written) { resolve() }
		})
		if (!written) { stream.once("drain", resolve) }
	})
}
