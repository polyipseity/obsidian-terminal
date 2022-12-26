import "node:process"
import {
	type FileSystemAdapter,
	MarkdownView,
	type Menu,
	Platform,
	Plugin,
	TFolder,
} from "obsidian"
import { SettingTab, type TerminalExecutables, getDefaultSettings } from "./settings"
import type Settings from "./settings"
import { notice } from "./util"
import { spawn } from "child_process"

export default class ObsidianTerminalPlugin extends Plugin {
	public readonly adapter = this.app.vault.adapter as FileSystemAdapter
	public readonly settings: Settings = getDefaultSettings()

	public async onload(): Promise<void> {
		if (!Platform.isDesktopApp) {
			return
		}

		await this.loadSettings()
		this.addSettingTab(new SettingTab(this.app, this))

		const spawnTerminal = (cwd: string): void => {
			if (!(process.platform in this.settings.executables)) {
				return
			}
			const exec =
				this.settings.executables[process.platform as keyof TerminalExecutables],
				noticeTimeout = 10000
			notice(`Spawning terminal: ${exec}`, noticeTimeout)
			spawn(exec, {
				cwd,
				detached: true,
				shell: true,
				stdio: "ignore",
			})
				.on("error", err => {
					console.error(`Error spawning terminal: ${err.name}: ${err.message}`)
					notice(`Error spawning terminal: ${err.name}: ${err.message}`)
				})
				.unref()
		}

		this.addCommand({
			checkCallback: checking => {
				if (!this.settings.command) {
					return false
				}
				if (!checking) {
					spawnTerminal(this.adapter.getBasePath())
				}
				return true
			},
			id: "open-external-terminal-root",
			name: "Open in external terminal (root)",
		})
		this.addCommand({
			editorCheckCallback: (checking, _0, ctx) => {
				if (!this.settings.command || ctx.file === null) {
					return false
				}
				if (!checking) {
					spawnTerminal(this.adapter.getFullPath(ctx.file.parent.path))
				}
				return true
			},
			id: "open-external-terminal-editor",
			name: "Open in external terminal (editor)",
		})

		const addContextMenus = (menu: Menu, cwd: TFolder): void => {
			menu
				.addSeparator()
				.addItem(item => item
					.setTitle("Open in external terminal")
					.setIcon("terminal")
					.onClick(() => {
						spawnTerminal(this.adapter.getFullPath(cwd.path))
					}))
		}
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file,) => {
			if (!this.settings.contextMenu) {
				return
			}
			addContextMenus(menu, file instanceof TFolder ? file : file.parent)
		}))
		this.registerEvent(this.app.workspace.on(
			"editor-menu",
			(menu, _0, info,) => {
				if (!this.settings.contextMenu ||
					info instanceof MarkdownView ||
					info.file === null) {
					return
				}
				addContextMenus(menu, info.file.parent)
			},
		))
	}

	public async loadSettings(): Promise<void> {
		Object.assign(this.settings, await this.loadData())
	}

	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings)
	}
}
