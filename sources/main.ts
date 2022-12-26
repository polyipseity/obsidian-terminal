import { spawn } from "child_process"
import "node:process"
import { App, FileSystemAdapter, MarkdownView, Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian"

interface TerminalExecs {
	darwin: string
	linux: string
	win32: string
}
interface Settings {
	command: boolean
	context_menu: boolean
	execs: TerminalExecs
}
function getDefaultSettings(): Settings {
	return {
		command: true,
		context_menu: true,
		execs: {
			darwin: "Terminal.app",
			linux: "xterm",
			win32: "C:\\Windows\\System32\\cmd.exe",
		},
	}
}

export default class ObsidianTerminalPlugin extends Plugin {
	readonly adapter: FileSystemAdapter = this.app.vault.adapter as FileSystemAdapter
	readonly settings: Settings = getDefaultSettings()

	async onload(): Promise<void> {
		if (!Platform.isDesktopApp) return

		await this.loadSettings()
		this.addSettingTab(new SettingTab(this.app, this))

		const spawnTerminal = (cwd: string): void => {
			if (!(process.platform in this.settings.execs)) return
			const exec = this.settings.execs[process.platform as keyof TerminalExecs]
			new Notice("Spawning terminal: " + exec, 10000)
			spawn(exec, { cwd, shell: true, detached: true, stdio: "ignore", })
				.on("error", err => {
					console.error("Error spawning terminal: " + err)
					new Notice("Error spawning terminal: " + err.message)
				})
				.unref()
		}

		this.addCommand({
			id: "open-external-terminal-root",
			name: "Open in external terminal (root)",
			checkCallback: checking => {
				if (this.settings.command) {
					if (!checking) spawnTerminal(this.adapter.getBasePath())
					return true
				}
			}
		})
		this.addCommand({
			id: "open-external-terminal-editor",
			name: "Open in external terminal (editor)",
			editorCheckCallback: (checking, _, ctx) => {
				if (this.settings.command && ctx.file !== null) {
					if (!checking) spawnTerminal(this.adapter.getFullPath(ctx.file.parent.path))
					return true
				}
			}
		})

		const addContextMenus = (menu: Menu, cwd: TFolder): void => {
			menu
				.addSeparator()
				.addItem(item => item
					.setTitle("Open in external terminal")
					.setIcon("terminal")
					.onClick(() => spawnTerminal(this.adapter.getFullPath(cwd.path))))
		}
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file,) => {
			if (!this.settings.context_menu) return
			addContextMenus(menu, file instanceof TFolder ? file : file.parent)
		}))
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, _, info,) => {
			if (!this.settings.context_menu) return
			if (info instanceof MarkdownView) return
			if (info.file === null) return
			addContextMenus(menu, info.file.parent)
		}))
	}

	async onunload(): Promise<void> { }

	async loadSettings(): Promise<void> {
		Object.assign(this.settings, await this.loadData())
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings)
	}
}

class SettingTab extends PluginSettingTab {
	constructor(app: App, readonly plugin: ObsidianTerminalPlugin) {
		super(app, plugin)
	}

	display(): void {
		const { containerEl } = this
		containerEl.empty()
		containerEl.createEl("h1", { text: "Obsidian Terminal", })
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
				.setValue(this.plugin.settings.context_menu)
				.onChange(async value => {
					this.plugin.settings.context_menu = value
					await this.plugin.saveSettings()
				}))
			.addExtraButton(button => button
				.setTooltip("Reset")
				.setIcon("reset")
				.onClick(async () => {
					this.plugin.settings.context_menu = getDefaultSettings().context_menu
					await this.plugin.saveSettings()
					this.display()
				}))

		containerEl.createEl("h2", { text: "Executables", })
		for (const [key, def_val] of Object.entries(getDefaultSettings().execs)) {
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
						this.plugin.settings.execs[key0] = getDefaultSettings().execs[key0]
						await this.plugin.saveSettings()
						this.display()
					}))
		}
	}
}
