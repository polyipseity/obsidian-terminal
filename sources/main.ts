import { type App, Plugin, type PluginManifest } from "obsidian"
import {
	DeveloperConsolePseudoterminal,
	RefPsuedoterminal,
} from "./terminal/pseudoterminal.js"
import {
	LanguageManager,
	type PluginContext,
	SettingsManager,
	StatusBarHider,
	activeSelf,
	createI18n,
	lazyProxy,
	semVerString,
} from "@polyipseity/obsidian-plugin-library"
import { PluginLocales } from "../assets/locales.js"
import { Settings } from "./settings-data.js"
import { isNil } from "lodash-es"
import { loadDocumentations } from "./documentations.js"
import { loadIcons } from "./icons.js"
import { loadSettings } from "./settings.js"
import { loadTerminal } from "./terminal/load.js"
import { patch } from "./patches.js"

export class TerminalPlugin
	extends Plugin
	implements PluginContext<Settings> {
	public readonly version
	public readonly log
	public readonly settings: SettingsManager<Settings>
	public readonly language: LanguageManager
	public readonly statusBarHider = new StatusBarHider(this)
	public readonly developerConsolePTY = lazyProxy(() => new RefPsuedoterminal(
		new DeveloperConsolePseudoterminal(activeSelf, this.log),
	))

	public constructor(app: App, manifest: PluginManifest) {
		const { unpatch, log } = patch(app.workspace)
		super(app, manifest)
		this.register(unpatch)
		this.log = log
		try {
			this.version = semVerString(manifest.version)
		} catch (error) {
			self.console.warn(error)
			this.version = null
		}
		this.settings = new SettingsManager(
			this,
			Settings.fix(Settings.DEFAULT).value,
			Settings.fix,
		)
		this.language = new LanguageManager(
			this,
			async () => createI18n(
				PluginLocales.RESOURCES,
				PluginLocales.FORMATTERS,
				{
					defaultNS: PluginLocales.DEFAULT_NAMESPACE,
					fallbackLng: PluginLocales.FALLBACK_LANGUAGES,
					returnNull: PluginLocales.RETURN_NULL,
				},
			),
		)
		this.register(async () => this.developerConsolePTY.kill())
	}

	public displayName(unlocalized = false): string {
		return unlocalized
			? this.language.i18n.t("name", {
				interpolation: { escapeValue: false },
				lng: PluginLocales.DEFAULT_LANGUAGE,
			})
			: this.language.i18n.t("name")
	}

	public override onload(): void {
		super.onload()
		const { language, settings, statusBarHider } = this;
		(async (): Promise<void> => {
			try {
				const [loaded] =
					await Promise.all([settings.onLoaded, language.onLoaded])
				await Promise.all([
					Promise.resolve().then(() => { loadIcons(this) }),
					(async (): Promise<void> => {
						const docs = loadDocumentations(this, isNil(await loaded))
						loadSettings(this, docs)
					})(),
					Promise.resolve().then(() => { loadTerminal(this) }),
					Promise.resolve().then(() => {
						this.register(settings.on(
							"mutate-settings",
							settings0 => settings0.hideStatusBar,
							() => { statusBarHider.update() },
						))
						statusBarHider.hide(() =>
							settings.copy.hideStatusBar === "always")
					}),
				])
			} catch (error) {
				self.console.error(error)
			}
		})()
	}
}
// Needed for loading
export default TerminalPlugin
