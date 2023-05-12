import { type AnyObject, launderUnchecked } from "./types"
import {
	type BaseComponent,
	ButtonComponent,
	type Command,
	type DataAdapter,
	DropdownComponent,
	type FrontMatterCache,
	Notice,
	Plugin,
	type PluginManifest,
	Setting,
	View,
	type ViewStateResult,
	addIcon as addIcon0,
	removeIcon,
} from "obsidian"
import { DOMClasses, NOTICE_NO_TIMEOUT, SI_PREFIX_SCALE } from "sources/magic"
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem"
import {
	Functions,
	clear,
	createChildElement,
	deepFreeze,
	inSet,
	multireplace,
	onVisible,
	replaceAllRegex,
	typedStructuredClone,
} from "./util"
import { cloneDeep, constant, isUndefined } from "lodash-es"
import { revealPrivate, revealPrivateAsync } from "./private"
import { DEFAULT_LANGUAGE } from "assets/locales"
import type { PLACEHOLDERPlugin } from "sources/main"
import { Platform } from "./platforms"
import { around } from "monkey-around"
import { saveAs } from "file-saver"

export class UpdatableUI {
	readonly #updaters = new Functions({ async: false })
	readonly #finalizers = new Functions({ async: false })

	public new<V>(
		create: () => V,
		configure?: ((value: V) => void) | null,
		destroy?: ((value: V) => void) | null,
	): this {
		const value = create()
		try {
			if (configure) {
				const updater = (): void => { configure(value) }
				updater()
				this.#updaters.push(updater)
			}
			if (destroy) {
				this.#finalizers.push(() => { destroy(value) })
			}
			return this
		} catch (error) {
			if (destroy) { destroy(value) }
			throw error
		}
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
								cb(component)
								try {
									components.push(component)
								} catch (error) {
									self.console.error(error)
								}
							})
						}
						const comp = components[index++ % components.length]
						if (!comp) { throw new Error(index.toString()) }
						try {
							comp.setDisabled(false)
							if ("onChange" in comp && typeof comp.onChange === "function") {
								try {
									comp.onChange((): void => { })
								} catch (error) {
									self.console.error(error)
								}
							}
							if ("removeCta" in comp && typeof comp.removeCta === "function") {
								try {
									comp.removeCta()
								} catch (error) {
									self.console.error(error)
								}
							}
							if (comp instanceof ButtonComponent) {
								comp.buttonEl.classList.remove(DOMClasses.MOD_WARNING)
							}
							if (comp instanceof DropdownComponent) {
								comp.selectEl.replaceChildren()
							}
						} catch (error) {
							self.console.error(error)
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
			update = true
			if (configure) { configure(ele) }
		}, ele => {
			ele.destroy()
			if (destroy) { destroy(ele) }
		})
	}

	public update(): void {
		this.#updaters.call()
	}

	public destroy(): void {
		this.#finalizers.transform(self => self.splice(0)).call()
		clear(this.#updaters)
	}
}

export function statusUI(ui: UpdatableUI, element: HTMLElement): {
	readonly report: (status?: unknown) => void
} {
	ui.new(constant(element), () => { }, () => { element.textContent = null })
	return deepFreeze({
		report(status?: unknown) {
			element.textContent = isUndefined(status) ? null : String(status)
		},
	})
}

export class UnnamespacedID<V extends string> {
	public constructor(public readonly id: V) { }

	public namespaced(plugin: Plugin | PluginManifest): string {
		return `${(plugin instanceof Plugin
			? plugin.manifest
			: plugin).id}:${this.id}`
	}
}

type AddCommandPredefinedOptions = {
	readonly [K in "name"]: Command[K]
}
export function addCommand(
	plugin: PLACEHOLDERPlugin,
	name: () => string,
	command: Readonly<Omit<Command, keyof AddCommandPredefinedOptions>>,
): Command {
	const { i18n } = plugin.language
	let namer = name
	return plugin.addCommand(Object.assign(
		{
			get name(): string { return namer() },
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
		} satisfies AddCommandPredefinedOptions,
		command,
	))
}

export function addIcon(
	id: string,
	content: string,
): () => void {
	addIcon0(id, content)
	return () => { removeIcon(id) }
}

export function addRibbonIcon(
	plugin: PLACEHOLDERPlugin,
	id: string,
	icon: string,
	title: () => string,
	callback: (event: MouseEvent) => unknown,
): void {
	const { app: { workspace: { leftRibbon } }, language } = plugin
	revealPrivate(
		plugin,
		[leftRibbon],
		leftRibbon0 => {
			const ribbon = (): readonly [ele: HTMLElement, title: string] => {
				const title0 = title()
				return Object.freeze([
					leftRibbon0.addRibbonItemButton(
						new UnnamespacedID(id).namespaced(plugin),
						icon,
						title0,
						callback,
					), title0,
				])
			}
			let [ele, title0] = ribbon()
			plugin.register(() => {
				leftRibbon0.removeRibbonAction(title0)
				ele.remove()
			})
			plugin.register(language.onChangeLanguage.listen(() => {
				ele.replaceWith(([ele, title0] = ribbon())[0])
			}))
		},
		_0 => { plugin.addRibbonIcon(icon, id, callback) },
	)
}

export function awaitCSS(
	plugin: Plugin | PluginManifest,
	element: HTMLElement,
): void {
	const { classList, style, style: { display } } = element,
		id = new UnnamespacedID(DOMClasses.Namespaced.AWAIT_CSS).namespaced(plugin)
	style.display = "none"
	const obsr = onVisible(element, () => {
		try {
			style.display = display
			classList.remove(id)
		} finally { obsr.disconnect() }
	})
	classList.add(id)
}

export function cleanFrontmatterCache(
	cache?: FrontMatterCache,
): Readonly<Record<string, unknown>> {
	if (!cache) { return deepFreeze({}) }
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
	return () => multireplace(format, {
		[cmd]: cmdNamer(),
		[defaultPluginName]: pluginNamer(),
	})
}

export function printMalformedData(
	plugin: PLACEHOLDERPlugin,
	actual: unknown,
	expected?: unknown,
): void {
	const { i18n } = plugin.language,
		tryClone = (thing: unknown): unknown => {
			try {
				return cloneDeep(thing)
			} catch (error) {
				self.console.warn(error)
				return thing
			}
		}
	self.console.error(
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
	plugin?: PLACEHOLDERPlugin,
): Notice {
	const timeoutMs = SI_PREFIX_SCALE * Math.max(timeout, 0),
		ret = new Notice(message(), timeoutMs)
	if (!plugin) { return ret }
	const unreg = plugin.language.onChangeLanguage
		.listen(() => ret.setMessage(message()))
	if (timeoutMs > 0) {
		self.setTimeout(unreg, timeoutMs)
	}
	return ret
}

export function notice2(
	message: () => DocumentFragment | string,
	timeout = NOTICE_NO_TIMEOUT,
	plugin?: PLACEHOLDERPlugin,
): void {
	if (timeout >= 0) {
		notice(message, timeout, plugin)
	}
}

export function printError(
	error: Error,
	message = (): string => "",
	plugin?: PLACEHOLDERPlugin,
): void {
	self.console.error(`${message()}\n`, error)
	notice2(
		() => `${message()}\n${error.name}: ${error.message}`,
		plugin?.settings.errorNoticeTimeout,
		plugin,
	)
}

export function readStateCollabratively(
	implType: string,
	state: unknown,
): unknown {
	return launderUnchecked<AnyObject>(state)[implType]
}

export function recordViewStateHistory(
	plugin: PLACEHOLDERPlugin,
	result: ViewStateResult,
): void {
	revealPrivate(plugin, [result], result0 => {
		result0.history = true
	}, _0 => { })
}

export async function saveFileAs(
	plugin: PLACEHOLDERPlugin,
	adapter: DataAdapter,
	data: File,
): Promise<void> {
	if (inSet(Platform.MOBILE, Platform.CURRENT)) {
		await revealPrivateAsync(plugin, [adapter], async ({ fs }) => {
			await fs.open<typeof Platform.CURRENT>(
				(await Filesystem.writeFile({
					data: await data.text(),
					directory: Directory.Cache,
					encoding: Encoding.UTF8,
					path: data.name,
				})).uri,
			)
		}, async _0 => { })
		return
	}
	saveAs(data)
}

export function updateDisplayText(plugin: PLACEHOLDERPlugin, view: View): void {
	revealPrivate(plugin, [view.leaf], leaf => {
		const { containerEl } = view,
			{ tabHeaderEl, tabHeaderInnerTitleEl } = leaf,
			text = view.getDisplayText(),
			viewHeaderEl =
				containerEl.querySelector(`.${DOMClasses.VIEW_HEADER_TITLE}`),
			{ textContent: oldText } = tabHeaderInnerTitleEl
		tabHeaderEl.ariaLabel = text
		tabHeaderInnerTitleEl.textContent = text
		if (viewHeaderEl) { viewHeaderEl.textContent = text }
		if (plugin.app.workspace.getActiveViewOfType(View) === view &&
			oldText !== null) {
			const { ownerDocument } = containerEl
			ownerDocument.title =
				ownerDocument.title.replace(replaceAllRegex(oldText), text)
		}
	}, _0 => { })
}

export function useSettings(element: HTMLElement): {
	readonly element: HTMLElement
	readonly remover: () => void
} {
	const container = createChildElement(element, "div", ele => {
		ele.classList.add(DOMClasses.VERTICAL_TAB_CONTENT_CONTAINER)
	})
	return Object.freeze({
		element: createChildElement(container, "div", ele => {
			ele.classList.add(DOMClasses.VERTICAL_TAB_CONTENT)
		}),
		remover() { container.remove() },
	})
}

export function useSubsettings(element: HTMLElement): HTMLElement {
	const ret = createChildElement(element, "div")
	if (element.firstChild) { createChildElement(ret, "div") }
	return ret
}

export function writeStateCollabratively(
	state: unknown,
	implType: string,
	implState: unknown,
): unknown {
	return Object.assign(launderUnchecked(state), { [implType]: implState })
}
