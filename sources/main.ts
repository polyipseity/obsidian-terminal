import {
	type Editor,
	type FileSystemAdapter,
	type MarkdownFileInfo,
	MarkdownView,
	type Menu,
	Platform,
	Plugin,
	TFolder,
} from "obsidian"
import { SettingTab, type TerminalExecutables, getDefaultSettings } from "./settings"
import { TerminalView, type TerminalViewState } from "./terminal"
import type Settings from "./settings"
import { notice } from "./util"
import { platform } from "process"
import { spawn } from "child_process"

type TerminalType = "external" | "integrated"

export default class ObsidianTerminalPlugin extends Plugin {
	public readonly settings: Settings = getDefaultSettings()
	protected readonly adapter = this.app.vault.adapter as FileSystemAdapter
	protected readonly platform: keyof TerminalExecutables | null =
		platform in this.settings.executables
			? platform as keyof TerminalExecutables
			: null

	public async onload(): Promise<void> {
		if (!Platform.isDesktopApp) {
			return
		}
		await this.loadSettings()
		this.addSettingTab(new SettingTab(this))
		this.registerView(
			TerminalView.viewType,
			leaf => new TerminalView(this, leaf),
		)

		const terminalSpawnCommand = (type: TerminalType,) => (
			checking: boolean,
			_0?: Editor,
			ctx?: MarkdownFileInfo | MarkdownView,
		): boolean => {
			if (!this.settings.command) {
				return false
			}
			if (typeof ctx === "undefined") {
				if (!checking) {
					void this._spawnTerminal(this.adapter.getBasePath(), type)
				}
				return true
			}
			if (ctx.file === null) {
				return false
			}
			if (!checking) {
				void this._spawnTerminal(
					this.adapter.getFullPath(ctx.file.parent.path),
					type,
				)
			}
			return true
		}
		this.addCommand({
			checkCallback: terminalSpawnCommand("external"),
			id: "open-external-terminal-root",
			name: "Open in external terminal (root)",
		})
		this.addCommand({
			checkCallback: terminalSpawnCommand("integrated"),
			id: "open-integrated-terminal-root",
			name: "Open in integrated terminal (root)",
		})
		this.addCommand({
			editorCheckCallback: terminalSpawnCommand("external"),
			id: "open-external-terminal-editor",
			name: "Open in external terminal (editor)",
		})
		this.addCommand({
			editorCheckCallback: terminalSpawnCommand("integrated"),
			id: "open-integrated-terminal-editor",
			name: "Open in integrated terminal (editor)",
		})

		const addContextMenus = (menu: Menu, cwd: TFolder): void => {
			menu
				.addSeparator()
				.addItem(item => item
					.setTitle("Open in external terminal")
					.setIcon("terminal")
					.onClick(async () => {
						await this._spawnTerminal(this.adapter.getFullPath(cwd.path), "external")
					}))
				.addItem(item => item
					.setTitle("Open in integrated terminal")
					.setIcon("terminal-square")
					.onClick(async () => {
						await this._spawnTerminal(this.adapter.getFullPath(cwd.path), "integrated")
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

	private async _spawnTerminal(cwd: string, type: TerminalType): Promise<void> {
		if (this.platform === null) {
			throw Error("Unsupported platform")
		}
		const executable =
			this.settings.executables[this.platform]
		notice(`Spawning terminal: ${executable}`, this.settings.noticeTimeout)
		switch (type) {
			case "external": {
				spawn(executable, {
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
				break
			}
			case "integrated": {
				const leaf = this.app.workspace.getLeaf("split", "horizontal"),
					state: TerminalViewState =
					{
						cwd,
						executable,
						platform: this.platform,
						type: "TerminalViewState",
					}
				await leaf.setViewState({
					active: true,
					state,
					type: TerminalView.viewType,
				})
				this.app.workspace.revealLeaf(leaf)
				this.app.workspace.setActiveLeaf(leaf, { focus: true })
				break
			}
			default:
				throw new TypeError(type)
		}
	}
}
