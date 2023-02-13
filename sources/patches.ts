import { EventEmitterLite, Functions } from "./utils/util"
import type { DeepReadonly } from "ts-essentials"
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
		export type Typed<T extends Type> = Event & { readonly type: T }
	}
}
const LOG: Log.Event[] = []
LOGGER.listen(event => LOG.push(event))

export function patch(): () => void {
	const unpatchers = new Functions({ async: false, settled: true })
	try {
		const consolePatch = (
			type: "debug" | "error" | "info" | "warn",
			proto: (...data: unknown[]) => void,
		) => function fn(this: Console, ...data: unknown[]) {
			proto.apply(this, data)
			LOGGER.emit({ data, type }).catch(() => { })
		}
		unpatchers.push(around(console, {
			debug(proto) { return consolePatch("debug", proto) },
			error(proto) { return consolePatch("error", proto) },
			log(proto) { return consolePatch("info", proto) },
			warn(proto) { return consolePatch("warn", proto) },
		}))
		const
			onWindowError = (error: ErrorEvent): void => {
				LOGGER.emit({
					data: error,
					type: "windowError",
				}).catch(() => { })
			},
			onUnhandledRejection = (error: PromiseRejectionEvent): void => {
				LOGGER.emit({
					data: error,
					type: "unhandledRejection",
				}).catch(() => { })
			}
		unpatchers.push(
			() => {
				window.removeEventListener("error", onWindowError, { capture: true })
			},
			() => {
				window.removeEventListener(
					"unhandledrejection",
					onUnhandledRejection,
					{ capture: true },
				)
			},
		)
		window.addEventListener("error", onWindowError, {
			capture: true,
			passive: true,
		})
		window.addEventListener("unhandledrejection", onUnhandledRejection, {
			capture: true,
			passive: true,
		})
	} catch (error) {
		unpatchers.call()
		throw error
	}
	return () => { unpatchers.call() }
}

export function log(): DeepReadonly<typeof LOG> { return LOG }
