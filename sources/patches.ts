import type { DeepReadonly } from "ts-essentials"
import { EventEmitterLite } from "./utils/util"
import type { PluginManifest } from "obsidian"
import { TerminalView } from "./terminal/view"
import { around } from "monkey-around"

export const LOGGER = new EventEmitterLite<readonly [Log.Event]>()
export namespace Log {
	export const TYPES = Object.freeze([
		"info",
		"error",
		"warn",
		"debug",
		"windowError",
		"unhandledRejection",
	] as const)
	export type Type = typeof TYPES[number]
	interface BaseEvent {
		readonly type: Type
	}
	export type Event = BaseEvent & (
		{
			readonly type: "debug" | "error" | "info" | "warn"
			readonly data: unknown[]
		} | {
			readonly type: "unhandledRejection"
			readonly data: PromiseRejectionEvent
		} | {
			readonly type: "windowError"
			readonly data: ErrorEvent
		}
	)
	export namespace Event {
		export type Typed<T extends Type> = Event & { readonly type: T }
	}
}
const LOG: Log.Event[] = []
LOGGER.listen(event => LOG.push(event))

export function patch(manifest: PluginManifest): () => void {
	const unpatchers: (() => void)[] = [],
		unpatch = (): void => {
			try {
				unpatchers.forEach(unwinder => {
					try { unwinder() } catch (error) { console.error(error) }
				})
			} catch (error) {
				console.error(error)
			}
		}
	try {
		const consolePatch = (
			type: "debug" | "error" | "info" | "warn",
			proto: (...data: unknown[]) => void,
		) => function fn(...data: unknown[]) {
			proto(...data)
			LOGGER.emit({ data, type }).catch(() => { })
		}
		unpatchers.push(
			around(console, {
				debug(proto) { return consolePatch("debug", proto) },
				error(proto) { return consolePatch("error", proto) },
				log(proto) { return consolePatch("info", proto) },
				warn(proto) { return consolePatch("warn", proto) },
			}),
			around(window, {
				onerror(proto) {
					return function fn(event, filename, lineno, colno, error) {
						let ret: unknown = false
						if (proto !== null) {
							ret = proto(event, filename, lineno, colno, error)
						}
						LOGGER.emit({
							data: new ErrorEvent("error", {
								colno: colno ?? 0,
								error,
								filename: filename ?? "",
								lineno: lineno ?? 0,
								message: event instanceof Event ? event.type : event,
							}),
							type: "windowError",
						}).catch(() => { })
						return ret
					}
				},
				onunhandledrejection(proto) {
					return function fn(
						this: WindowEventHandlers,
						event: PromiseRejectionEvent,
					) {
						// eslint-disable-next-line no-void
						let ret: unknown = void 0
						if (proto !== null) {
							ret = proto.call(this as Window, event)
						}
						LOGGER.emit({ data: event, type: "unhandledRejection" })
							.catch(() => { })
						return ret
					}
				},
				toString(proto) {
					return function fn(...args) { return proto(...args) }
				},
			}),
		)
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
	} catch (error) {
		unpatch()
		throw error
	}
	return unpatch
}

export function log(): DeepReadonly<typeof LOG> { return LOG }
