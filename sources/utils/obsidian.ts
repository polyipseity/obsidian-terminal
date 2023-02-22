import { type AnyObject, launderUnchecked } from "./types"
import {
	type BaseComponent,
	ButtonComponent,
	type Command,
	type Debouncer,
	DropdownComponent,
	type FrontMatterCache,
	Notice,
	Plugin,
	type PluginManifest,
	Setting,
	View,
} from "obsidian"
import { DOMClasses, NOTICE_NO_TIMEOUT, SI_PREFIX_SCALE } from "sources/magic"
import {
	EMPTY_OBJECT,
	Functions,
	createChildElement,
	deepFreeze,
	isNonNullish,
	isUndefined,
	typedStructuredClone,
} from "./util"
import type { AsyncOrSync } from "ts-essentials"
import { DEFAULT_LANGUAGE } from "assets/locales"
import type { TerminalPlugin } from "sources/main"
import { around } from "monkey-around"

export class UpdatableUI {
	readonly #updaters = new Functions({ async: false })
	readonly #finalizers = new Functions({ async: false })

	public new<V>(
		create: () => V,
		configure?: ((value: V) => void) | null,
		destroy?: ((value: V) => void) | null,
	): this {
		const value = create()
		if (isNonNullish(configure)) {
			const updater = (): void => { configure(value) }
			updater()
			this.#updaters.push(updater)
		}
		if (isNonNullish(destroy)) {
			this.#finalizers.push(() => { destroy(value) })
		}
		return this
	}

	public newSetting(
		element: HTMLElement,
		configure: (setting: Setting) => void,
	): this {
		let recording = true
		return this.new(() => {
			const setting = new Setting(element),
				patch = <C extends BaseComponent>(proto: (
					cb: (component: C) => unknown,
				) => Setting): (cb: (component: C) => unknown) => Setting => {
					const components: C[] = []
					let index = 0
					return function fn(
						this: Setting,
						cb: (component: C) => unknown,
					): Setting {
						if (recording) {
							return proto.call(this, component => {
								components.push(component)
								cb(component)
							})
						}
						const comp = components[index++ % components.length]
						if (isUndefined(comp)) {
							throw new Error(index.toString())
						}
						comp.setDisabled(false)
						if ("onChange" in comp) {
							try {
								(comp.onChange as ((
									callback: (value: unknown) => unknown,
								) => unknown))((): void => { })
							} catch (error) {
								console.error(error)
							}
						}
						if ("removeCta" in comp) {
							try {
								(comp.removeCta as (() => void))()
							} catch (error) {
								console.error(error)
							}
						}
						if (comp instanceof ButtonComponent) {
							comp.buttonEl.classList.remove(DOMClasses.MOD_WARNING)
						}
						if (comp instanceof DropdownComponent) {
							comp.selectEl.replaceChildren()
						}
						cb(comp)
						return this
					}
				}
			around(setting, {
				addButton: patch,
				addColorPicker: patch,
				addDropdown: patch,
				addExtraButton: patch,
				addMomentFormat: patch,
				addSearch: patch,
				addSlider: patch,
				addText: patch,
				addTextArea: patch,
				addToggle: patch,
			} satisfies { [key in (keyof Setting) & `add${string}`]: unknown })
			return setting
		}, setting => {
			configure(setting)
			recording = false
		}, setting => { setting.settingEl.remove() })
	}

	public finally(finalizer: () => void): this {
		this.#finalizers.push(finalizer)
		return this
	}

	public embed<U extends this>(
		create: () => U,
		configure?: ((ele: U) => void) | null,
		destroy?: ((ele: U) => void) | null,
	): this {
		let update = false
		return this.new(create, ele => {
			if (update) { ele.update() }
			update = true;
			(configure ?? ((): void => { }))(ele)
		}, ele => {
			ele.destroy();
			(destroy ?? ((): void => { }))(ele)
		})
	}

	public update(): void {
		this.#updaters.call()
	}

	public destroy(): void {
		this.#finalizers.transform(self => self.splice(0)).call()
		this.#updaters.length = 0
	}
}

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin
			? plugin.manifest
			: plugin).id}:${this.id}`
	}
}

export function addCommand(
	plugin: TerminalPlugin,
	name: () => string,
	command: Omit<Readonly<Command>, "name">,
): Command {
	const { i18n } = plugin.language
	let namer = name
	return plugin.addCommand({
		...command,
		get name() { return namer() },
		set name(format) {
			namer = commandNamer(
				name,
				() => i18n.t("name"),
				i18n.t("name", {
					interpolation: { escapeValue: false },
					lng: DEFAULT_LANGUAGE,
				}),
				format,
			)
		},
	})
}

export function addRibbonIcon(
	plugin: TerminalPlugin,
	id: string,
	icon: string,
	title: () => string,
	callback: (event: MouseEvent) => unknown,
): void {
	const { app, language } = plugin,
		{ workspace } = app,
		{ leftRibbon } = workspace
	usePrivateAPI(
		plugin,
		() => {
			const ribbon = (): readonly [HTMLElement, string] => {
				const title0 = title()
				return [
					leftRibbon.addRibbonItemButton(
						new UnnamespacedID(id).namespaced(plugin),
						icon,
						title0,
						callback,
					), title0,
				]
			}
			let [ele, title0] = ribbon()
			plugin.register(() => {
				leftRibbon.removeRibbonAction(title0)
				ele.remove()
			})
			plugin.register(language.onChangeLanguage.listen(() => {
				ele.replaceWith(([ele, title0] = ribbon())[0])
			}))
		},
		() => { plugin.addRibbonIcon(icon, id, callback) },
	)
}

export function asyncDebounce<
	A extends readonly unknown[],
	R,
	R0,
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
>(debouncer: R0 extends void ? Debouncer<[
	(value: AsyncOrSync<R>) => void,
	(reason?: unknown) => void,
	...A], R0> : never): (...args: A) => Promise<R> {
	const promises: {
		readonly resolve: (value: AsyncOrSync<R>) => void
		readonly reject: (reason?: unknown) => void
	}[] = []
	return async (...args: A): Promise<R> =>
		new Promise((resolve, reject) => {
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

export function cleanFrontmatterCache(
	cache?: FrontMatterCache,
): Readonly<Record<string, unknown>> {
	if (isUndefined(cache)) { return EMPTY_OBJECT }
	const ret = typedStructuredClone<Partial<typeof cache>>(cache)
	delete ret.position
	return deepFreeze(ret)
}

export function commandNamer(
	cmdNamer: () => string,
	pluginNamer: () => string,
	defaultPluginName: string,
	format: string,
): () => string {
	const cmd = cmdNamer()
	return () => format
		.replace(cmd, cmdNamer())
		.replace(defaultPluginName, pluginNamer())
}

export function printMalformedData(
	plugin: TerminalPlugin,
	actual: unknown,
	expected?: unknown,
): void {
	const { i18n } = plugin.language,
		tryClone = (thing: unknown): unknown => {
			try {
				return typedStructuredClone(thing)
			} catch (error) {
				console.warn(error)
				return thing
			}
		}
	console.error(
		i18n.t("errors.malformed-data"),
		tryClone(actual),
		tryClone(expected),
	)
	notice2(
		() => i18n.t("errors.malformed-data"),
		plugin.settings.errorNoticeTimeout,
		plugin,
	)
}

export function newCollabrativeState(
	plugin: Plugin | PluginManifest,
	states: ReadonlyMap<UnnamespacedID<string>, unknown>,
): unknown {
	const entries = (function* fn(): Generator<readonly [string, unknown], void> {
		for (const [key, value] of states.entries()) {
			yield [key.namespaced(plugin), value]
		}
	}())
	return Object.freeze(Object.fromEntries(entries))
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

export function readStateCollabratively(
	implType: string,
	state: unknown,
): unknown {
	return launderUnchecked<AnyObject>(state)[implType]
}

export function updateDisplayText(plugin: TerminalPlugin, view: View): void {
	usePrivateAPI(plugin, () => {
		const { containerEl, leaf } = view,
			{ tabHeaderEl, tabHeaderInnerTitleEl } = leaf,
			text = view.getDisplayText(),
			viewHeaderEl =
				containerEl.querySelector(`.${DOMClasses.VIEW_HEADER_TITLE}`),
			{ textContent: oldText } = tabHeaderInnerTitleEl
		tabHeaderEl.ariaLabel = text
		tabHeaderInnerTitleEl.textContent = text
		if (viewHeaderEl !== null) { viewHeaderEl.textContent = text }
		if (plugin.app.workspace.getActiveViewOfType(View) === view &&
			oldText !== null) {
			const { ownerDocument } = containerEl
			ownerDocument.title = ownerDocument.title.replace(oldText, text)
		}
	}, () => { })
}

export function usePrivateAPI<R>(
	plugin: TerminalPlugin,
	func: () => R,
	fallback: (error: unknown) => R,
): R {
	try {
		return func()
	} catch (error) {
		console.warn(plugin.language.i18n.t("errors.private-API-changed"), error)
		return fallback(error)
	}
}

export function useSettings(element: HTMLElement): readonly [
	HTMLElement,
	() => void,
] {
	const container = createChildElement(element, "div", ele => {
		ele.classList.add(DOMClasses.VERTICAL_TAB_CONTENT_CONTAINER)
	})
	return [
		createChildElement(container, "div", ele => {
			ele.classList.add(DOMClasses.VERTICAL_TAB_CONTENT)
		}),
		(): void => { container.remove() },
	]
}

export function useSubsettings(element: HTMLElement): HTMLElement {
	const first = element.firstChild === null,
		ret = createChildElement(element, "div")
	if (!first) { createChildElement(ret, "div") }
	return ret
}

export function writeStateCollabratively(
	state: unknown,
	implType: string,
	implState: unknown,
): unknown {
	return Object.assign(launderUnchecked(state), { [implType]: implState })
}
