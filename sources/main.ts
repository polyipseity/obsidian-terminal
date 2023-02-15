import { type App, Plugin, type PluginManifest, debounce } from "obsidian"
import type { AsyncOrSync, DeepWritable } from "ts-essentials"
import { EventEmitterLite, copyOnWriteAsync, isUndefined } from "./utils/util"
import { JSON_STRINGIFY_SPACE, SAVE_SETTINGS_TIMEOUT } from "./magic"
import { asyncDebounce, printMalformedData } from "./utils/obsidian"
import { LanguageManager } from "./i18n"
import { Settings } from "./settings/data"
import { StatusBarHider } from "./status-bar"
import { loadIcons } from "./icons"
import { loadSettings } from "./settings/load"
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

	public async loadSettings(
		settings: DeepWritable<Settings>,
		loader: () => unknown = async (): Promise<unknown> => this.loadData(),
	): Promise<void> {
		const loaded: unknown = await loader(),
			{ value, valid } = Settings.fix(loaded)
		Object.assign(settings, value)
		if (!valid) {
			printMalformedData(this, loaded)
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
				loadSettings(this)
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
