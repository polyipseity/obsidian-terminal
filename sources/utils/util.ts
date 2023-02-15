import type { AsyncOrSync, DeepReadonly, DeepWritable } from "ts-essentials"
import { JSON_STRINGIFY_SPACE, UNDEFINED } from "sources/magic"
import type { PrimitiveType, TypeofMap } from "./typeof"
import { type Sized, simplify } from "./types"
import type { ChildProcess } from "node:child_process"
import type { Writable } from "node:stream"
import { getSerialize } from "json-stringify-safe"

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
		...args: (Async extends true ? (
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

export function capitalize(
	str: string,
	locales?: string[] | string,
): string {
	const cp0 = str.codePointAt(0)
	if (isUndefined(cp0)) { return "" }
	const char0 = String.fromCodePoint(cp0)
	return `${char0.toLocaleUpperCase(locales)}${str.slice(char0.length)}`
}

export function copyOnWrite<T extends object>(
	obj: DeepReadonly<T>,
	mutator: (obj: DeepWritable<T>) => void,
): DeepReadonly<T> {
	const ret = simplify(cloneAsWritable(obj))
	mutator(ret)
	return simplify(deepFreeze(ret))
}

export async function copyOnWriteAsync<T extends object>(
	obj: DeepReadonly<T>,
	mutator: (obj: DeepWritable<T>) => unknown,
): Promise<DeepReadonly<T>> {
	const ret = simplify(cloneAsWritable(obj))
	await mutator(ret)
	return simplify(deepFreeze(ret))
}

export function clear(self: unknown[]): void {
	self.length = 0
}

export function clearProperties(self: object): void {
	for (const prop of Object.getOwnPropertyNames(self)) {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete self[prop as keyof typeof self]
	}
	for (const prop of Object.getOwnPropertySymbols(self)) {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete self[prop as keyof typeof self]
	}
}

export function cloneAsWritable<T>(obj: T): DeepWritable<T> {
	// `readonly` is fake at runtime
	return typedStructuredClone(obj) as DeepWritable<T>
}

export function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (typeof value === "object" && value !== null) {
		Object.values(value).forEach(deepFreeze)
	}
	return Object.freeze(value) as DeepReadonly<T>
}

export function escapeQuerySelectorAttribute(value: string): string {
	return value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")
}

export function executeParanoidly<T>(callback: (
	resolve: (value: AsyncOrSync<T>) => void,
	reject: (reason?: unknown) => void,
) => void) {
	return (
		resolve: (value: AsyncOrSync<T>) => void,
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

) => AsyncOrSync<T>): Promise<T> {
	const ret = await spawn()
	return new Promise<T>(executeParanoidly((resolve, reject) => {
		ret.once("spawn", () => { resolve(ret) })
			.once("error", reject)
	}))
}

export function typedKeys<T extends readonly (number | string | symbol)[]>() {
	return <O extends (keyof O extends T[number] ? {
		readonly [_ in T[number]]: unknown
	} : never)>(obj: O): Readonly<T> =>
		Object.freeze(Object.keys(obj)) as T
}

export function typedStructuredClone<T>(
	value: T,
	transfer?: StructuredSerializeOptions,
): T {
	return structuredClone(value, transfer) as T
}

export function identity<T>(value: T): T {
	return value
}

export function isHomogenousArray<T extends PrimitiveType>(
	type: T,
	value: unknown,
): value is TypeofMap[T][] {
	if (!Array.isArray(value)) { return false }
	return value.every(element => typeof element === type)
}

export function isNonNullish<T>(value: T | null | undefined): value is T {
	return !isNullish(value)
}

export function isNull(value: unknown): value is null {
	return value === null
}

export function isNullish(value: unknown): value is null | undefined {
	return isNull(value) || isUndefined(value)
}

export function inSet<T extends readonly unknown[]>(
	set: Sized<T>,
	obj: unknown,
): obj is T[number] {
	return set.includes(obj)
}

export function isUndefined(value: unknown): value is undefined {
	return typeof value === "undefined"
}

export function insertAt<T>(
	self: T[],
	index: number,
	...items: readonly T[]
): void {
	self.splice(index, 0, ...items)
}

export function length<T extends object,
>(obj: T extends readonly unknown[] ? never : T): number {
	return Object.keys(obj).length
}

export function logFormat(...args: readonly unknown[]): string {
	if (args.length <= 0) { return "" }
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
					if (func !== null) {
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

export function onResize(
	element: Element,
	callback: (entry: ResizeObserverEntry) => unknown,
): ResizeObserver {
	const ret = new ResizeObserver(ents => {
		const ent = ents.at(-1)
		if (isUndefined(ent)) { return }
		callback(ent)
	})
	ret.observe(element)
	return ret
}

export function onVisible(
	element: Element,
	callback: (entry: IntersectionObserverEntry) => unknown,
	transient = false,
): IntersectionObserver {
	const ret = new IntersectionObserver(ents => {
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

export function openExternal(url?: URL | string): Window | null {
	return window.open(url, "_blank", "noreferrer")
}

export async function promisePromise<T>(): Promise<{
	readonly promise: Promise<T>
	readonly resolve: (value: AsyncOrSync<T>) => void
	readonly reject: (reason?: unknown) => void
}> {
	return new Promise(executeParanoidly((resolve0, reject0) => {
		const promise = new Promise<T>(executeParanoidly((resolve, reject) => {
			Promise.resolve()
				.then(() => ({ promise, reject, resolve }))
				.then(resolve0, reject0)
		}))
	}))
}

export function randomNotIn(
	self: readonly string[],
	generator = (): string => crypto.randomUUID(),
): string {
	let ret = generator()
	while (self.includes(ret)) { ret = generator() }
	return ret
}

export function remove<T>(self: T[], item: T): T | undefined {
	return removeAt(self, self.indexOf(item))
}

export function removeAt<T>(self: T[], index: number): T | undefined {
	return self.splice(index, 1)[0]
}

export function swap(self: unknown[], left: number, right: number): void {
	[self[left], self[right]] = [self[right], self[left]]
}

export function unexpected(): never {
	throw new Error()
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
