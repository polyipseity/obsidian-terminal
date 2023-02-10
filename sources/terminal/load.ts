import {
	type FileSystemAdapter,
	MarkdownView,
	type Menu,
	TFolder,
	type WorkspaceLeaf,
} from "obsidian"
import {
	PLATFORM,
	anyToError,
	commandNamer,
	deepFreeze,
	inSet,
	notice2,
	printError,
} from "../utils/util"
import { DEFAULT_LANGUAGE } from "assets/locales"
import { Pseudoterminal } from "./pseudoterminal"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "../main"
import { TerminalView } from "./view"
import { spawnExternalTerminalEmulator } from "./emulator"

export function loadTerminal(plugin: TerminalPlugin): void {
	const
		CWD_TYPES = deepFreeze(["root", "current"] as const),
		TERMINAL_TYPES = deepFreeze(["external", "integrated"] as const),
		{ app, settings, language } = plugin,
		{ i18n } = language
	type CwdType = typeof CWD_TYPES[number]
	type TerminalType = typeof TERMINAL_TYPES[number]
	let terminalSpawnCommand = (
		_terminal: TerminalType,
		_cwd: CwdType,
	) => (_checking: boolean): boolean => false

	plugin.registerView(
		TerminalView.type.namespaced(plugin),
		leaf => new TerminalView(plugin, leaf),
	)

	if (inSet(Pseudoterminal.SUPPORTED_PLATFORMS, PLATFORM)) {
		const
			adapter = app.vault.adapter as FileSystemAdapter,
			spawnTerminal = (
				cwd: string,
				terminal: TerminalType,
			): void => {
				(async (): Promise<void> => {
					try {
						const { profiles, noticeTimeout, errorNoticeTimeout } = settings
						switch (terminal) {
							case "external": {
								const profile =
									Settings.Profile.defaultOfType(terminal, profiles)
								if (profile === null) { break }
								const { executable, args } = profile
								notice2(
									() => i18n.t(
										"notices.spawning-terminal",
										{ name: executable },
									),
									noticeTimeout,
									plugin,
								)
								await spawnExternalTerminalEmulator(
									executable,
									cwd,
									args,
								)
								return
							}
							case "integrated": {
								const profile =
									Settings.Profile.defaultOfType(terminal, profiles)
								if (profile === null) { break }
								const { executable } = profile
								notice2(
									() => i18n.t(
										"notices.spawning-terminal",
										{ name: executable },
									),
									settings.noticeTimeout,
									plugin,
								)
								const { workspace } = app,
									existingLeaves = workspace
										.getLeavesOfType(TerminalView.type.namespaced(plugin))
								await ((): WorkspaceLeaf => {
									const existingLeaf = existingLeaves.at(-1)
									if (typeof existingLeaf === "undefined") {
										return workspace.getLeaf("split", "horizontal")
									}
									workspace.setActiveLeaf(existingLeaf, { focus: false })
									return workspace.getLeaf("tab")
								})()
									.setViewState({
										active: true,
										state: {
											__type: TerminalView.State.TYPE,
											cwd,
											profile,
										} satisfies TerminalView.State,
										type: TerminalView.type.namespaced(plugin),
									})
								return
							}
							// No default
						}
						notice2(
							() => i18n.t(
								"notices.no-default-profile",
								{
									type: i18n.t(`types.profiles.${terminal}`),
								},
							),
							errorNoticeTimeout,
							plugin,
						)
					} catch (error) {
						printError(
							anyToError(error),
							() => i18n.t("errors.error-spawning-terminal"),
							plugin,
						)
					}
				})()
			},
			addContextMenus = (menu: Menu, cwd: TFolder): void => {
				menu.addSeparator()
				for (const terminal of TERMINAL_TYPES) {
					menu.addItem(item => item
						.setTitle(i18n.t(`menus.open-terminal-${terminal}`))
						.setIcon(i18n.t(`asset:menus.open-terminal-${terminal}-icon`))
						.onClick(() => {
							spawnTerminal(
								adapter.getFullPath(cwd.path),
								terminal,
							)
						}))
				}
			}
		terminalSpawnCommand = (
			terminal: TerminalType,
			cwd: CwdType,
		) => (checking: boolean): boolean => {
			if (!settings.addToCommand) {
				return false
			}
			switch (cwd) {
				case "root": {
					if (!checking) {
						spawnTerminal(adapter.getBasePath(), terminal)
					}
					return true
				}
				case "current": {
					const activeFile = app.workspace.getActiveFile()
					if (activeFile === null) {
						return false
					}
					if (!checking) {
						spawnTerminal(
							adapter.getFullPath(activeFile.parent.path),
							terminal,
						)
					}
					return true
				}
				// No default
			}
		}
		plugin.registerEvent(app.workspace.on("file-menu", (menu, file) => {
			if (!settings.addToContextMenu) {
				return
			}
			addContextMenus(menu, file instanceof TFolder ? file : file.parent)
		}))
		plugin.registerEvent(app.workspace.on(
			"editor-menu",
			(menu, _0, info) => {
				if (!settings.addToContextMenu ||
					info instanceof MarkdownView ||
					info.file === null) {
					return
				}
				addContextMenus(menu, info.file.parent)
			},
		))
	}
	for (const terminal of TERMINAL_TYPES) {
		for (const cwd of CWD_TYPES) {
			const id = `open-terminal-${terminal}-${cwd}` as const
			let namer = (): string => i18n.t(`commands.${id}`)
			// Always register command for interop with other plugins
			plugin.addCommand({
				checkCallback: terminalSpawnCommand(terminal, cwd),
				id,
				get name() { return namer() },
				set name(format) {
					namer = commandNamer(
						() => i18n.t(`commands.${id}`),
						() => i18n.t("name"),
						i18n.t("name", { lng: DEFAULT_LANGUAGE }),
						format,
					)
				},
			})
		}
	}
}
