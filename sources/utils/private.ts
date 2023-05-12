import type { PLACEHOLDERPlugin } from "sources/main"

declare const PRIVATE: unique symbol
export interface Private<T> { readonly [PRIVATE]: T }
export type RevealPrivate<T extends Private<unknown>> =
	Omit<T, typeof PRIVATE> & T[typeof PRIVATE]

export function revealPrivate<const As extends readonly Private<unknown>[], R>(
	plugin: PLACEHOLDERPlugin,
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
	plugin: PLACEHOLDERPlugin,
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
