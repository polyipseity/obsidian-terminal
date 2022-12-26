import { type App, PluginSettingTab, Setting } from "obsidian"
import type ObsidianTerminalPlugin from "./main"

export default interface Settings {
	command: boolean
	contextMenu: boolean
	execs: TerminalExecs
}
export interface TerminalExecs {
	darwin: string
	linux: string
	win32: string
}
export function getDefaultSettings(): Settings {
	return {
		command: true,
		contextMenu: true,
		execs: {
			darwin: "Terminal.app",
			linux: "xterm",
			win32: "C:\\Windows\\System32\\cmd.exe",
		},
	}
}

export class SettingTab extends PluginSettingTab {
	public constructor(
		app: App,
		public readonly plugin: ObsidianTerminalPlugin,
	) {
		super(app, plugin)
	}

	public display(): void {
		const { containerEl } = this
		containerEl.empty()
		containerEl.createEl("h1", { text: "Obsidian Terminal" })
		new Setting(containerEl)
			.setName("Reset all")
			.addButton(button => button
				.setTooltip("Reset")
				.setIcon("reset")
				.onClick(async () => {
					Object.assign(this.plugin.settings, getDefaultSettings())
					await this.plugin.saveSettings()
					this.display()
				}))

		new Setting(containerEl)
			.setName("Command")
			.setDesc("Add terminal commands.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.command)
				.onChange(async value => {
					this.plugin.settings.command = value
					await this.plugin.saveSettings()
				}))
			.addExtraButton(button => button
				.setTooltip("Reset")
				.setIcon("reset")
				.onClick(async () => {
					this.plugin.settings.command = getDefaultSettings().command
					await this.plugin.saveSettings()
					this.display()
				}))
		new Setting(containerEl)
			.setName("Context menu")
			.setDesc("Add terminal buttons to context menus.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.contextMenu)
				.onChange(async value => {
					this.plugin.settings.contextMenu = value
					await this.plugin.saveSettings()
				}))
			.addExtraButton(button => button
				.setTooltip("Reset")
				.setIcon("reset")
				.onClick(async () => {
					this.plugin.settings.contextMenu =
						getDefaultSettings().contextMenu
					await this.plugin.saveSettings()
					this.display()
				}))

		containerEl.createEl("h2", { text: "Executables" })
		for (const key of Object.keys(getDefaultSettings().execs)) {
			const key0 = key as keyof TerminalExecs
			new Setting(containerEl)
				.setName(key)
				.addText(text => text
					.setValue(this.plugin.settings.execs[key0])
					.onChange(async value => {
						this.plugin.settings.execs[key0] = value
						await this.plugin.saveSettings()
					}))
				.addExtraButton(button => button
					.setTooltip("Reset")
					.setIcon("reset")
					.onClick(async () => {
						this.plugin.settings.execs[key0] =
							getDefaultSettings().execs[key0]
						await this.plugin.saveSettings()
						this.display()
					}))
		}
	}
}
