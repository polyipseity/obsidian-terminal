import { type App, Plugin, type PluginManifest } from "obsidian"
import { DEFAULT_SETTINGS, SettingTab, Settings } from "./settings"
import { TerminalView, registerTerminal } from "./terminal"
import { LanguageManager } from "./i18n"
import { StatusBarHider } from "./status-bar"
import { cloneAsMutable } from "./util"

export class TerminalPlugin extends Plugin {
	public readonly settings = cloneAsMutable(DEFAULT_SETTINGS)
	public readonly language = new LanguageManager(this)
	public readonly statusBarHider = new StatusBarHider(this)

	public constructor(app: App, manifest: PluginManifest) {
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
		super(app, manifest)
	}

	public override async onload(): Promise<void> {
		super.onload()
		await Settings.load(this.settings, this)
		await this.language.load()
		this.statusBarHider.load()
		this.addSettingTab(new SettingTab(this))
		registerTerminal(this)
	}
}
// Needed for loading
export default TerminalPlugin
