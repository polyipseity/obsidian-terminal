import {
	FileSystemAdapter,
	FuzzySuggestModal,
	type MenuItem,
	TFolder,
	type WorkspaceLeaf,
} from "obsidian"
import {
	UNDEF,
	commandNamer,
	deepFreeze,
	isNonNullish,
	isUndefined,
} from "../utils/util"
import { addRibbonIcon, notice2 } from "sources/utils/obsidian"
import { DEFAULT_LANGUAGE } from "assets/locales"
import { PROFILE_PROPERTIES } from "sources/settings/profile-properties"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "../main"
import { TerminalView } from "./view"

function spawnTerminal(
	plugin: TerminalPlugin,
	profile: Settings.Profile,
	cwd?: string,
): void {
	const { workspace } = app,
		existingLeaves = workspace
			.getLeavesOfType(TerminalView.type.namespaced(plugin));
	((): WorkspaceLeaf => {
		const existingLeaf = existingLeaves.at(-1)
		if (isUndefined(existingLeaf)) {
			return workspace.getLeaf("split", "horizontal")
		}
		workspace.setActiveLeaf(existingLeaf, { focus: false })
		return workspace.getLeaf("tab")
	})()
		.setViewState({
			active: true,
			state: {
				cwd,
				profile,
			} satisfies TerminalView.State,
			type: TerminalView.type.namespaced(plugin),
		})
		.catch(error => { console.error(error) })
}

class SelectProfileModal
	extends FuzzySuggestModal<Settings.Profile.Entry> {
	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly cwd?: string,
	) {
		super(plugin.app)
	}

	public override getItems(): Settings.Profile.Entry[] {
		return Object.entries(this.plugin.settings.profiles)
	}

	public override getItemText(item: Settings.Profile.Entry): string {
		return Settings.Profile.nameOrID(item)
	}

	public override onChooseItem(
		item: Settings.Profile.Entry,
		_evt: KeyboardEvent | MouseEvent,
	): void {
		spawnTerminal(this.plugin, item[1], this.cwd)
	}
}

export function loadTerminal(plugin: TerminalPlugin): void {
	plugin.registerView(
		TerminalView.type.namespaced(plugin),
		leaf => new TerminalView(plugin, leaf),
	)

	const
		CWD_TYPES = deepFreeze(["", "root", "current"] as const),
		PROFILE_TYPES = deepFreeze((["select", "integrated", "external"] as const)
			.filter(type => type === "select" || PROFILE_PROPERTIES[type].available)),
		{ app, language } = plugin,
		{ workspace } = app,
		{ i18n } = language
	type CWDType = typeof CWD_TYPES[number]
	const defaultProfile =
		(type: Settings.Profile.Type): Settings.Profile | null => {
			const ret = Settings.Profile.defaultOfType(type, plugin.settings.profiles)
			if (ret === null) {
				notice2(
					() => i18n.t(
						"notices.no-default-profile",
						{
							type: i18n.t(`types.profiles.${type}`),
						},
					),
					plugin.settings.errorNoticeTimeout,
					plugin,
				)
			}
			return ret
		},
		adapter = app.vault.adapter instanceof FileSystemAdapter
			? app.vault.adapter
			: null,
		contextMenu = (
			type: Settings.Profile.Type | "select",
			cwd?: TFolder,
		): ((item: MenuItem) => void) | null => {
			const cwd0 = isUndefined(cwd)
				? cwd
				: adapter === null ? null : adapter.getFullPath(cwd.path)
			if (cwd0 === null) { return null }
			return (item: MenuItem) => {
				item
					.setTitle(i18n.t("menus.open-terminal", {
						type: i18n.t(`types.profiles.${type}`),
					}))
					.setIcon(i18n.t(`asset:types.profiles.${type}-icon`))
					.onClick(() => {
						if (type === "select") {
							new SelectProfileModal(plugin, cwd0).open()
							return
						}
						const profile = defaultProfile(type)
						if (profile === null) { return }
						spawnTerminal(
							plugin,
							profile,
							cwd0,
						)
					})
			}
		},
		command = (
			type: Settings.Profile.Type | "select",
			cwd: CWDType,
		) => (checking: boolean) => {
			// eslint-disable-next-line consistent-return
			const cwd0 = ((): string | null | undefined => {
				if (cwd === "") { return UNDEF }
				if (adapter === null) { return null }
				switch (cwd) {
					case "root":
						return adapter.getBasePath()
					case "current": {
						const active = workspace.getActiveFile()
						if (active === null) { return null }
						return adapter.getFullPath(active.parent.path)
					}
					// No default
				}
			})()
			if (cwd0 === null) { return false }
			if (!checking) {
				if (type === "select") {
					new SelectProfileModal(plugin, cwd0).open()
					return true
				}
				const profile = defaultProfile(type)
				if (profile !== null) {
					spawnTerminal(plugin, profile, cwd0)
				}
			}
			return true
		}

	addRibbonIcon(
		plugin,
		i18n.t("asset:ribbons.open-terminal-id"),
		i18n.t("asset:ribbons.open-terminal-icon"),
		() => i18n.t("ribbons.open-terminal"),
		() => { new SelectProfileModal(plugin).open() },
	)
	plugin.registerEvent(workspace.on("file-menu", (menu, file) => {
		if (!plugin.settings.addToContextMenu) {
			return
		}
		const folder = file instanceof TFolder ? file : file.parent
		menu.addSeparator()
		const items = PROFILE_TYPES
			.map(type => contextMenu(type, folder))
			.filter(isNonNullish)
		if (items.length > 0) {
			menu.addSeparator()
			items.forEach(item => menu.addItem(item))
		}
	}))
	plugin.registerEvent(workspace.on(
		"editor-menu",
		(menu, _0, info) => {
			if (!plugin.settings.addToContextMenu || info.file === null) {
				return
			}
			const folder = info.file.parent
			menu.addSeparator()
			const items = PROFILE_TYPES
				.map(type => contextMenu(type, folder))
				.filter(isNonNullish)
			if (items.length > 0) {
				menu.addSeparator()
				items.forEach(item => menu.addItem(item))
			}
		},
	))
	// Always register command for interop with other plugins
	for (const cwd of CWD_TYPES) {
		for (const type of PROFILE_TYPES) {
			const id = `open-terminal-${cwd}.${type}` as const
			let namer = (): string => i18n.t(`commands.open-terminal-${cwd}`, {
				type: i18n.t(`types.profiles.${type}`),
			})
			plugin.addCommand({
				checkCallback: checking => {
					if (!plugin.settings.addToCommand) { return false }
					return command(type, cwd)(checking)
				},
				id,
				get name() { return namer() },
				set name(format) {
					namer = commandNamer(
						() => i18n.t(`commands.open-terminal-${cwd}`, {
							type: i18n.t(`types.profiles.${type}`),
						}),
						() => i18n.t("name"),
						i18n.t("name", { lng: DEFAULT_LANGUAGE }),
						format,
					)
				},
			})
		}
	}
}
