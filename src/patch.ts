import {
	EventEmitterLite,
	Functions,
	ResourceComponent,
	aroundIdentityFactory,
	deepFreeze,
	dynamicRequireSync,
	patchWindows,
} from "@polyipseity/obsidian-plugin-library"
import type { App } from "obsidian"
import type { TerminalPlugin } from "./main.js"
import { around } from "monkey-around"
import { noop } from "lodash-es"

export class Log {
	public readonly logger = new EventEmitterLite<readonly [Log.Event]>()
	readonly #history: Log.Event[] = []

	public constructor(protected readonly maxHistory = NaN) {
		this.logger.listen(event => {
			const his = this.#history
			his.push(event)
			his.splice(0, his.length - maxHistory)
		})
	}

	public get history(): readonly Log.Event[] {
		return this.#history
	}
}
export namespace Log {
	export type Event = { readonly type: Event.Type } & (
		{
			readonly type: "debug" | "error" | "info" | "warn"
			readonly data: readonly unknown[]
		} | {
			readonly type: "unhandledRejection"
			readonly data: PromiseRejectionEvent
		} | {
			readonly type: "windowError"
			readonly data: ErrorEvent
		}
	)
	export namespace Event {
		export const TYPES = deepFreeze([
			"info",
			"error",
			"warn",
			"debug",
			"windowError",
			"unhandledRejection",
		])
		export type Type = typeof TYPES[number]
		export type Typed<T extends Type> = Event & { readonly type: T }
	}
}

function patchLoggingConsole(console: Console, log: Log): () => void {
	function consolePatch<const T extends "debug" | "error" | "info" | "warn">(
		type: T,
		proto: typeof console[T],
	): typeof proto {
		let recursive = false
		return function fn(
			this: typeof console,
			...args: Parameters<typeof proto>
		): void {
			if (recursive) { return }
			recursive = true
			try {
				try {
					log.logger.emit({ data: args, type })
						.catch(noop satisfies () => unknown as () => unknown)
				} catch (error) {
					this.error(error)
				} finally {
					proto.apply(this, args)
				}
			} finally {
				recursive = false
			}
		}
	}
	return around(console, {
		debug(next) { return consolePatch("debug", next) },
		error(next) { return consolePatch("error", next) },
		log(next) { return consolePatch("info", next) },
		warn(next) { return consolePatch("warn", next) },
	})
}

function patchLoggingWindow(self0: Window, log: Log): () => void {
	const
		onWindowError = (error: ErrorEvent): void => {
			log.logger.emit({
				data: error,
				type: "windowError",
			}).catch(noop satisfies () => unknown as () => unknown)
		},
		onUnhandledRejection = (error: PromiseRejectionEvent): void => {
			log.logger.emit({
				data: error,
				type: "unhandledRejection",
			}).catch(noop satisfies () => unknown as () => unknown)
		},
		ret = new Functions(
			{ async: false, settled: true },
			() => {
				self0.removeEventListener("error", onWindowError, { capture: true })
			},
			() => {
				self0.removeEventListener(
					"unhandledrejection",
					onUnhandledRejection,
					{ capture: true },
				)
			},
		)
	try {
		self0.addEventListener("error", onWindowError, {
			capture: true,
			passive: true,
		})
		self0.addEventListener("unhandledrejection", onUnhandledRejection, {
			capture: true,
			passive: true,
		})
		return () => { ret.call() }
	} catch (error) {
		ret.call()
		throw error
	}
}

function patchLogging(
	self0: Window & typeof globalThis,
	log: Log,
): () => void {
	const ret = new Functions({ async: false, settled: true })
	try {
		ret.push(patchLoggingConsole(self0.console, log))
		ret.push(patchLoggingWindow(self0, log))
		return () => { ret.call() }
	} catch (error) {
		ret.call()
		throw error
	}
}

export interface EarlyPatch {
	readonly log: Log
	readonly enableLoggingPatch: (enable: boolean) => void
}
function earlyPatch(app: App, options?: {
	readonly maxHistory?: number | undefined
}): EarlyPatch & { readonly unpatch: () => void } {
	const unpatch = new Functions({ async: false, settled: true })
	try {
		const { workspace } = app,
			log = new Log(options?.maxHistory)
		let loggingPatch: (() => void) | null = null

		unpatch.push(() => { if (loggingPatch) { loggingPatch() } })
		loggingPatch = patchWindows(workspace, self0 => patchLogging(self0, log))

		return Object.freeze({
			enableLoggingPatch(enable: boolean) {
				if (enable) {
					if (loggingPatch) { return }
					loggingPatch =
						patchWindows(workspace, self0 => patchLogging(self0, this.log))
					return
				}
				if (!loggingPatch) { return }
				try {
					loggingPatch()
				} finally {
					loggingPatch = null
				}
			},
			log,
			unpatch() { unpatch.call() },
		})
	} catch (error) {
		unpatch.call()
		throw error
	}
}

export class EarlyPatchManager extends ResourceComponent<EarlyPatch> {
	#loaded = false

	public constructor(
		protected readonly app: App,
		protected readonly options?: Parameters<typeof earlyPatch>[1],
	) { super() }

	public override load(): void {
		if (this.#loaded) { return }
		super.load()
		this.register(() => { this.#loaded = false })
		this.#loaded = true
	}

	protected override load0(): EarlyPatch {
		const ret = earlyPatch(this.app, this.options)
		this.register(ret.unpatch)
		return ret
	}
}

function patchRequire(
	context: TerminalPlugin,
	self0: typeof globalThis,
): () => void {
	const { settings } = context
	return around(self0, {
		require(next) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			return function fn(
				this: typeof self0 | undefined,
				...args: Parameters<typeof next>
			): ReturnType<typeof next> {
				try {
					return next.apply(this, args)
				} catch (error) {
					if (!settings.value.exposeInternalModules) { throw error }
					/* @__PURE__ */ self0.console.debug(error)
					return dynamicRequireSync(new Map(), ...args)
				}
			} as NodeJS.Require
		},
		toString: aroundIdentityFactory(),
	})
}

export function loadPatch(context: TerminalPlugin): void {
	const { app: { workspace } } = context
	context.register(patchWindows(workspace, self0 =>
		patchRequire(context, self0)))
}
