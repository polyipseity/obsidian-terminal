/* eslint-disable @typescript-eslint/indent */
declare module "obsidian" {
	// eslint-disable-next-line @typescript-eslint/no-empty-interface
	interface DataAdapter
		extends WithOpaque<"1a0bdb0b-6247-440e-a21b-8e943edb9505"> { }
	// eslint-disable-next-line @typescript-eslint/no-empty-interface
	interface ViewStateResult
		extends WithOpaque<"3dda7a60-b4fe-4ae7-91b7-d52f21637858"> { }
	// eslint-disable-next-line @typescript-eslint/no-empty-interface
	interface WorkspaceLeaf
		extends WithOpaque<"a3d0210e-3e6c-4cb2-b1a6-8d559232a4b1"> { }
	// eslint-disable-next-line @typescript-eslint/no-empty-interface
	interface WorkspaceRibbon
		extends WithOpaque<"8c9ec649-af19-487d-998f-4ff86d2480b3"> { }
}

import type {
	DataAdapter,
	ViewStateResult,
	WorkspaceLeaf,
	WorkspaceRibbon,
} from "obsidian"
import type { IsNever, WithOpaque } from "ts-essentials"
import type { Platform } from "./platforms"
import type { Sized } from "./types"
import type { TerminalPlugin } from "sources/main"

export function revealPrivate<R, const As extends readonly unknown[]>(
	plugin: TerminalPlugin,
	args: true extends {
		readonly [A in keyof As]: IsNever<RevealPrivate<As[A]>>
	}[number] ? never : Sized<As>,
	func: (...args: { readonly [A in keyof As]: RevealPrivate<As[A]> }) =>
		R extends PromiseLike<unknown> ? never : R,
	fallback: (error: unknown, ...args: As) =>
		R extends PromiseLike<unknown> ? never : R,
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
export async function revealPrivateAsync<R extends PromiseLike<unknown>,
	const As extends readonly unknown[]>(
		plugin: TerminalPlugin,
		args: true extends {
			readonly [A in keyof As]: IsNever<RevealPrivate<As[A]>>
		}[number] ? never : Sized<As>,
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
export type RevealPrivate<T> =
	T extends DataAdapter ? $DataAdapter :
	T extends ViewStateResult ? $ViewStateResult :
	T extends WorkspaceLeaf ? $WorkspaceLeaf :
	T extends WorkspaceRibbon ? $WorkspaceRibbon :
	never

interface $DataAdapter extends DataAdapter {
	readonly fs: {
		readonly open: <T extends Platform.Current>(
			path: T extends Platform.Mobile ? string : never,
		) => T extends Platform.Mobile ? PromiseLike<void> : never
	}
}

interface $ViewStateResult extends ViewStateResult {
	history: boolean
}

interface $WorkspaceLeaf extends WorkspaceLeaf {
	readonly tabHeaderEl: HTMLElement
	readonly tabHeaderInnerIconEl: HTMLElement
	readonly tabHeaderInnerTitleEl: HTMLElement
}

interface $WorkspaceRibbon extends WorkspaceRibbon {
	readonly addRibbonItemButton: (
		id: string,
		icon: string,
		title: string,
		callback: (event: MouseEvent) => unknown,
	) => HTMLElement
	readonly removeRibbonAction: (title: string) => void
}
