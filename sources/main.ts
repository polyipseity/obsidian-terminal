import { type App, Plugin, type PluginManifest, debounce } from "obsidian"
import type { AsyncOrSync, DeepWritable } from "ts-essentials"
import { EventEmitterLite, copyOnWriteAsync, isUndefined } from "./utils/util"
import { JSON_STRINGIFY_SPACE, SAVE_SETTINGS_TIMEOUT } from "./magic"
import { LanguageManager } from "./i18n"
import { SettingTab } from "./settings/tab"
import { Settings } from "./settings/data"
import { StatusBarHider } from "./status-bar"
import { TerminalView } from "./terminal/view"
import { asyncDebounce } from "./utils/obsidian"
import { loadIcons } from "./icons"
import { loadTerminal } from "./terminal/load"
import { patch } from "./patches"

export class TerminalPlugin extends Plugin {
	public readonly language = new LanguageManager(this)
	public readonly statusBarHider = new StatusBarHider(this)
	public readonly saveSettings =
		asyncDebounce(debounce((
			resolve: (value: AsyncOrSync<void>) => void,
			reject: (reason?: unknown) => void,
		) => {
			this.saveData(this.settings).then(resolve, reject)
		}, SAVE_SETTINGS_TIMEOUT, false))

	#settings: Settings = { ...Settings.DEFAULT, recovery: {} }
	readonly #onMutateSettings = new EventEmitterLite<readonly [Settings]>()

	public constructor(app: App, manifest: PluginManifest) {
		const unpatch = patch()
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
		super(app, manifest)
		this.register(unpatch)
	}

	public get settings(): Settings {
		return this.#settings
	}

	public async mutateSettings(mutator: (
		settings: DeepWritable<Settings>) => unknown): Promise<void> {
		await this.#onMutateSettings.emit(this.#settings =
			await copyOnWriteAsync(this.#settings, mutator))
	}

	public async loadSettings(settings: DeepWritable<Settings>): Promise<void> {
		const loaded: unknown = await this.loadData(),
			{ value, valid } = Settings.fix(loaded)
		Object.assign(settings, value)
		if (!valid) {
			if (isUndefined(settings.recovery)) { settings.recovery = {} }
			settings.recovery[new Date().toISOString()] =
				JSON.stringify(loaded, null, JSON_STRINGIFY_SPACE)
		}
	}

	public on<T>(
		_event: "mutate-settings",
		accessor: (settings: Settings) => T,
		callback: (
			cur: T,
			prev: T,
			settings: Settings,
		) => unknown,
	): () => void {
		let prev = accessor(this.settings)
		return this.#onMutateSettings
			.listen(async (settings: Settings): Promise<void> => {
				const cur = accessor(settings),
					prev0 = prev
				if (prev0 !== cur) {
					prev = cur
					await callback(cur, prev0, settings)
				}
			})
	}

	public override onload(): void {
		super.onload();
		(async (): Promise<void> => {
			try {
				const init = Promise.all([
					this.mutateSettings(async settings => this.loadSettings(settings)),
					this.language.load(),
				])
				loadIcons(this)
				await init
				this.addSettingTab(new SettingTab(this))
				this.statusBarHider.load()
				loadTerminal(this)
			} catch (error) {
				console.error(error)
			}
		})()
	}
}
// Needed for loading
export default TerminalPlugin
