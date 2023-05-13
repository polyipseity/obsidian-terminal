import {
	FileSystemAdapter,
	MarkdownView,
	type MenuItem,
	TFolder,
} from "obsidian"
import {
	Platform,
	addCommand,
	addRibbonIcon,
	deepFreeze,
	isNonNil,
	notice2,
} from "obsidian-plugin-library"
import { SelectProfileModal, spawnTerminal } from "./spawn"
import { PROFILE_PROPERTIES } from "../settings/profile-properties"
import { Settings } from "../settings-data"
import type { TerminalPlugin } from "../main"
import { TerminalView } from "./view"
import { UNDEFINED } from "../magic"
import { isEmpty } from "lodash-es"

export function loadTerminal(context: TerminalPlugin): void {
	context.registerView(
		TerminalView.type.namespaced(context),
		leaf => new TerminalView(context, leaf),
	)
	const
		PROFILE_TYPES = deepFreeze((["select", "integrated", "external"] as const)
			.filter(type => type === "select" || PROFILE_PROPERTIES[type].available)),
		CWD_TYPES = deepFreeze(["", "root", "current"]),
		EXCLUDED_TYPES = deepFreeze([
			{ cwd: "", profile: "integrated" },
			{ cwd: "", profile: "external" },
		]),
		{ app: { vault, workspace }, language: { i18n }, settings } = context,
		defaultProfile =
			(type: Settings.Profile.Type): Settings.Profile | null => {
				const ret = Settings.Profile.defaultOfType(
					type,
					settings.copy.profiles,
					Platform.CURRENT,
				)
				if (!ret) {
					notice2(
						() => i18n.t("notices.no-default-profile", {
							interpolation: { escapeValue: false },
							type,
						}),
						settings.copy.errorNoticeTimeout,
						context,
					)
				}
				return ret
			},
		adapter = vault.adapter instanceof FileSystemAdapter
			? vault.adapter
			: null,
		contextMenu = (
			type: Settings.Profile.Type | "select",
			cwd?: TFolder,
		): ((item: MenuItem) => void) | null => {
			const cwd0 = cwd
				? adapter ? adapter.getFullPath(cwd.path) : null
				: cwd
			if (cwd0 === null) { return null }
			return (item: MenuItem) => {
				item
					.setTitle(i18n.t("menus.open-terminal", {
						interpolation: { escapeValue: false },
						type,
					}))
					.setIcon(i18n.t("asset:menus.open-terminal-icon", {
						interpolation: { escapeValue: false },
						type,
					}))
					.onClick(() => {
						if (type === "select") {
							new SelectProfileModal(context, cwd0).open()
							return
						}
						const profile = defaultProfile(type)
						if (!profile) { return }
						spawnTerminal(
							context,
							profile,
							cwd0,
						)
					})
			}
		},
		command = (
			type: Settings.Profile.Type | "select",
			cwd: typeof CWD_TYPES[number],
		) => (checking: boolean) => {
			// eslint-disable-next-line consistent-return
			const cwd0 = ((): string | null | undefined => {
				if (!cwd) { return UNDEFINED }
				if (!adapter) { return null }
				switch (cwd) {
					case "root":
						return adapter.getBasePath()
					case "current": {
						const active = workspace.getActiveFile()
						if (active?.parent) {
							return adapter.getFullPath(active.parent.path)
						}
						return null
					}
					// No default
				}
			})()
			if (cwd0 === null) { return false }
			if (!checking) {
				if (type === "select") {
					new SelectProfileModal(context, cwd0).open()
					return true
				}
				const profile = defaultProfile(type)
				if (profile) { spawnTerminal(context, profile, cwd0) }
			}
			return true
		}

	addRibbonIcon(
		context,
		i18n.t("asset:ribbons.open-terminal-id"),
		i18n.t("asset:ribbons.open-terminal-icon"),
		() => i18n.t("ribbons.open-terminal"),
		() => { new SelectProfileModal(context, adapter?.getBasePath()).open() },
	)
	context.registerEvent(workspace.on("file-menu", (menu, file) => {
		if (!settings.copy.addToContextMenu) {
			return
		}
		const folder = file instanceof TFolder ? file : file.parent
		if (!folder) { return }
		menu.addSeparator()
		const items = PROFILE_TYPES
			.map(type => contextMenu(type, folder))
			.filter(isNonNil)
		if (!isEmpty(items)) {
			menu.addSeparator()
			items.forEach(item => menu.addItem(item))
		}
	}))
	context.registerEvent(workspace.on(
		"editor-menu",
		(menu, _0, info) => {
			const { file } = info
			if (!settings.copy.addToContextMenu ||
				info instanceof MarkdownView ||
				!file?.parent) {
				return
			}
			const { parent } = file
			menu.addSeparator()
			const items = PROFILE_TYPES
				.map(type => contextMenu(type, parent))
				.filter(isNonNil)
			if (!isEmpty(items)) {
				menu.addSeparator()
				items.forEach(item => menu.addItem(item))
			}
		},
	))
	// Always register command for interop with other plugins
	for (const type of PROFILE_TYPES) {
		for (const cwd of CWD_TYPES) {
			if (EXCLUDED_TYPES.some(({ cwd: cwd0, profile }) =>
				cwd0 === cwd && profile === type)) {
				continue
			}
			addCommand(
				context,
				() => i18n.t(`commands.open-terminal-${cwd}`, {
					interpolation: { escapeValue: false },
					type,
				}),
				{
					checkCallback(checking) {
						if (!settings.copy.addToCommand) { return false }
						return command(type, cwd)(checking)
					},
					icon: i18n.t(`asset:commands.open-terminal-${cwd}-icon`),
					id: `open-terminal.${type}.${cwd}`,
				},
			)
		}
	}
}
