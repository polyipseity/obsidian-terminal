import { type DeepReadonly, noop } from "ts-essentials"
import { EventEmitterLite, Functions } from "./utils/util"
import type { Workspace } from "obsidian"
import { around } from "monkey-around"
import { correctType } from "./utils/types"

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
const LOGGER = new EventEmitterLite<readonly [Log.Event]>(),
	LOG_HISTORY: Log.Event[] = []
LOGGER.listen(event => LOG_HISTORY.push(event))

export const LOG: {
	readonly logger: typeof LOGGER
	readonly history: DeepReadonly<typeof LOG_HISTORY>
} = Object.freeze({ history: LOG_HISTORY, logger: LOGGER })

const consolePatch = (
	type: "debug" | "error" | "info" | "warn",
	proto: (...data: unknown[]) => void,
) => function fn(this: Console, ...data: unknown[]): void {
	proto.apply(this, data)
	LOGGER.emit({ data, type }).catch(noop)
}
function patchConsole(console: Console): () => void {
	return around(console, {
		debug(proto) { return consolePatch("debug", proto) },
		error(proto) { return consolePatch("error", proto) },
		log(proto) { return consolePatch("info", proto) },
		warn(proto) { return consolePatch("warn", proto) },
	})
}

const
	onWindowError = (error: ErrorEvent): void => {
		LOGGER.emit({
			data: error,
			type: "windowError",
		}).catch(noop)
	},
	onUnhandledRejection = (error: PromiseRejectionEvent): void => {
		LOGGER.emit({
			data: error,
			type: "unhandledRejection",
		}).catch(noop)
	}
function patchWindow(self: Window): () => void {
	const ret = new Functions(
		{ async: false, settled: true },
		() => {
			self.removeEventListener("error", onWindowError, { capture: true })
		},
		() => {
			self.removeEventListener(
				"unhandledrejection",
				onUnhandledRejection,
				{ capture: true },
			)
		},
	)
	try {
		self.addEventListener("error", onWindowError, {
			capture: true,
			passive: true,
		})
		self.addEventListener("unhandledrejection", onUnhandledRejection, {
			capture: true,
			passive: true,
		})
		return () => { ret.call() }
	} catch (error) {
		ret.call()
		throw error
	}
}

export function patch(workspace: Workspace): () => void {
	const unpatchers = new Functions({ async: false, settled: true })
	try {
		const windowConsolePatch = workspace.on("window-open", window => {
			const unpatch = patchConsole(correctType(window.win).console),
				off = workspace.on("window-close", window0 => {
					if (window !== window0) { return }
					try {
						unpatch()
					} finally { workspace.offref(off) }
				})
		})
		unpatchers.push(() => { workspace.offref(windowConsolePatch) })
		unpatchers.push(patchConsole(console))

		const windowWindowPatch = workspace.on("window-open", window => {
			const unpatch = patchWindow(window.win),
				off = workspace.on("window-close", window0 => {
					if (window !== window0) { return }
					try {
						unpatch()
					} finally { workspace.offref(off) }
				})
		})
		unpatchers.push(() => { workspace.offref(windowWindowPatch) })
		unpatchers.push(patchWindow(window))
		return () => { unpatchers.call() }
	} catch (error) {
		unpatchers.call()
		throw error
	}
}
