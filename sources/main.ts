import { type App, Plugin, type PluginManifest, debounce } from "obsidian"
import { DEFAULT_SETTINGS, Settings } from "./settings/data"
import {
	EventEmitterLite,
	type MaybePromise,
	type Mutable,
	asyncDebounce,
	copyOnWriteAsync,
} from "./utils/util"
import { LanguageManager } from "./i18n"
import { SAVE_SETTINGS_TIMEOUT } from "./magic"
import { SettingTab } from "./settings/tab"
import { StatusBarHider } from "./status-bar"
import { TerminalView } from "./terminal/view"
import { loadIcons } from "./icons"
import { loadTerminal } from "./terminal/load"

export class TerminalPlugin extends Plugin {
	public readonly language = new LanguageManager(this)
	public readonly statusBarHider = new StatusBarHider(this)
	public readonly saveSettings =
		asyncDebounce(debounce((
			resolve: (value: MaybePromise<void, "like">) => void,
			reject: (reason?: unknown) => void,
		) => {
			(async (): Promise<void> => {
				await this.saveData(this.settings)
			})().then(resolve, reject)
		}, SAVE_SETTINGS_TIMEOUT, false))

	#settings = DEFAULT_SETTINGS
	readonly #onMutateSettings = new EventEmitterLite<[Settings]>()

	public constructor(app: App, manifest: PluginManifest) {
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
		super(app, manifest)
	}

	public get settings(): Settings {
		return this.#settings
	}

	public async mutateSettings(mutator: (
		settings: Mutable<Settings>) => unknown): Promise<void> {
		await this.#onMutateSettings.emit(this.#settings =
			await copyOnWriteAsync(this.#settings, mutator))
	}

	public async loadSettings(settings: Mutable<Settings>): Promise<void> {
		Object.assign(settings, Settings.fix(await this.loadData()))
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
					this.mutateSettings(this.loadSettings.bind(this)),
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
