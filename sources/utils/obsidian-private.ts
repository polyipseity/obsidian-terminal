/* eslint-disable @typescript-eslint/no-empty-interface */
import type { Platform } from "./platforms"
import type { TerminalPlugin } from "sources/main"

export function revealPrivate<const As extends readonly Private<unknown>[], R>(
	plugin: TerminalPlugin,
	args: As,
	func: (
		...args: { readonly [A in keyof As]: RevealPrivate<As[A]> }
	) => R extends PromiseLike<unknown> ? never : R,
	fallback: (
		error: unknown,
		...args: As
	) => R extends PromiseLike<unknown> ? never : R,
): R extends PromiseLike<unknown> ? never : R {
	try {
		return func(...args as { readonly [A in keyof As]: RevealPrivate<As[A]> })
	} catch (error) {
		self.console.warn(
			plugin.language.i18n.t("errors.private-API-changed"),
			error,
		)
		return fallback(error, ...args)
	}
}
export async function revealPrivateAsync<
	const As extends readonly Private<unknown>[],
	R extends PromiseLike<unknown>,
>(
	plugin: TerminalPlugin,
	args: As,
	func: (...args: { readonly [A in keyof As]: RevealPrivate<As[A]> }) => R,
	fallback: (error: unknown, ...args: As) => R,
): Promise<Awaited<R>> {
	try {
		return await func(...args as
			{ readonly [A in keyof As]: RevealPrivate<As[A]> })
	} catch (error) {
		self.console.warn(
			plugin.language.i18n.t("errors.private-API-changed"),
			error,
		)
		return await fallback(error, ...args)
	}
}

declare const PRIVATE: unique symbol
interface Private<T> {
	readonly [PRIVATE]: T
}
export type RevealPrivate<T extends {
	readonly [PRIVATE]: unknown
}> = Omit<T, typeof PRIVATE> & T[typeof PRIVATE]
declare module "obsidian" {
	interface DataAdapter extends Private<$DataAdapter> { }
	interface ViewStateResult extends Private<$ViewStateResult> { }
	interface WorkspaceLeaf extends Private<$WorkspaceLeaf> { }
	interface WorkspaceRibbon extends Private<$WorkspaceRibbon> { }
}

interface $DataAdapter {
	readonly fs: {
		readonly open: <T extends Platform.Current>(
			path: T extends Platform.Mobile ? string : never,
		) => T extends Platform.Mobile ? PromiseLike<void> : never
	}
}

interface $ViewStateResult {
	history: boolean
}

interface $WorkspaceLeaf {
	readonly tabHeaderEl: HTMLElement
	readonly tabHeaderInnerIconEl: HTMLElement
	readonly tabHeaderInnerTitleEl: HTMLElement
}

interface $WorkspaceRibbon {
	readonly addRibbonItemButton: (
		id: string,
		icon: string,
		title: string,
		callback: (event: MouseEvent) => unknown,
	) => HTMLElement
	readonly removeRibbonAction: (title: string) => void
}
