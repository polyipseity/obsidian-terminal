
import {
	type Debouncer,
	Notice,
	Plugin,
	type PluginManifest,
	type View,
} from "obsidian"
import { NOTICE_NO_TIMEOUT, SI_PREFIX_SCALE } from "sources/magic"
import type { AsyncOrSync } from "ts-essentials"
import type { TerminalPlugin } from "sources/main"
import { isUndefined } from "./util"

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin
			? plugin.manifest
			: plugin).id}:${this.id}`
	}
}

export function asyncDebounce<
	A extends readonly unknown[],
	R,
	R0,
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
>(debouncer: R0 extends void ? Debouncer<[
	(value: AsyncOrSync<R>) => void,
	(reason?: unknown) => void,
	...A], R0> : never): (...args_0: A) => Promise<R> {
	const promises: {
		readonly resolve: (value: AsyncOrSync<R>) => void
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

export function notice(
	message: () => DocumentFragment | string,
	timeout: number = NOTICE_NO_TIMEOUT,
	plugin?: TerminalPlugin,
): Notice {
	const timeoutMs = SI_PREFIX_SCALE * Math.max(timeout, 0),
		ret = new Notice(message(), timeoutMs)
	if (isUndefined(plugin)) {
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
	timeout = NOTICE_NO_TIMEOUT,
	plugin?: TerminalPlugin,
): void {
	if (timeout >= 0) {
		notice(message, timeout, plugin)
	}
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

export function updateDisplayText(view: View): void {
	const { containerEl } = view,
		text = view.getDisplayText(),
		viewHeaderEl = containerEl.querySelector(".view-header-title")
	let oldText: string | null = null
	if (viewHeaderEl !== null) {
		oldText = viewHeaderEl.textContent
		viewHeaderEl.textContent = text
	}
	const leafEl = containerEl.parentElement
	if (leafEl !== null) {
		const leavesEl = leafEl.parentElement
		if (leavesEl !== null) {
			const
				headerEl = leavesEl.parentElement
					?.querySelector(".workspace-tab-header-container")
					?.querySelectorAll(".workspace-tab-header")
					.item(leavesEl.indexOf(leafEl)) ?? null,
				titleEl = headerEl
					?.querySelector(".workspace-tab-header-inner-title") ?? null
			oldText ??= titleEl?.textContent ?? null
			if (titleEl !== null) { titleEl.textContent = text }
			if (headerEl !== null) { headerEl.ariaLabel = text }
		}
	}
	if (oldText !== null) {
		document.title = document.title.replace(oldText, text)
	}
}
