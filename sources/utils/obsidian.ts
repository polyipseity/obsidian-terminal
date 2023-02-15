
import {
	type BaseComponent,
	ButtonComponent,
	type Command,
	type Debouncer,
	DropdownComponent,
	Notice,
	Plugin,
	type PluginManifest,
	Setting,
	View,
	type Workspace,
} from "obsidian"
import { DOMClasses, NOTICE_NO_TIMEOUT, SI_PREFIX_SCALE } from "sources/magic"
import { Functions, executeParanoidly, isNonNullish, isUndefined } from "./util"
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
							comp.buttonEl.removeClass(DOMClasses.MOD_WARNING)
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
			ele.clear();
			(destroy ?? ((): void => { }))(ele)
		})
	}

	public update(): void {
		this.#updaters.call()
	}

	public clear(): void {
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
				i18n.t("name", { lng: DEFAULT_LANGUAGE }),
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
		new Promise(executeParanoidly((resolve, reject) => {
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
		}))
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
	data: unknown,
): void {
	const { i18n } = plugin.language
	console.error(i18n.t("errors.malformed-data"), data)
	notice2(
		() => i18n.t("errors.malformed-data"),
		plugin.settings.errorNoticeTimeout,
		plugin,
	)
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

export function updateDisplayText(view: View, workspace: Workspace): void {
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
	if (workspace.getActiveViewOfType(View) === view && oldText !== null) {
		document.title = document.title.replace(oldText, text)
	}
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
	const container = element.createEl("div", {
		cls: DOMClasses.VERTICAL_TAB_CONTENT_CONTAINER,
	})
	return [
		container.createEl("div", {
			cls: DOMClasses.VERTICAL_TAB_CONTENT,
		}),
		(): void => { container.remove() },
	]
}

export function useSubsettings(element: HTMLElement): HTMLElement {
	const first = element.firstChild === null,
		ret = element.createEl("div")
	if (!first) { ret.createEl("div") }
	return ret
}
