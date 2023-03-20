import { FuzzySuggestModal, type WorkspaceLeaf } from "obsidian"
import { PLATFORM } from "sources/utils/util"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"
import { TerminalView } from "./view"
import { newCollabrativeState } from "sources/utils/obsidian"

export class SelectProfileModal
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
		return this.plugin.language.i18n.t(
			`components.select-profile.item-text-${Settings.Profile
				.isCompatible(item[1], PLATFORM)
				? ""
				: "incompatible"}`,
			{
				info: Settings.Profile.info(item),
				interpolation: { escapeValue: false },
			},
		)
	}

	public override onChooseItem(
		[, profile]: Settings.Profile.Entry,
		_evt: KeyboardEvent | MouseEvent,
	): void {
		const { plugin, cwd } = this
		spawnTerminal(plugin, profile, cwd)
	}
}

export function spawnTerminal(
	plugin: TerminalPlugin,
	profile: Settings.Profile,
	cwd?: string,
): void {
	(async (): Promise<void> => {
		try {
			const { app } = plugin,
				{ workspace } = app,
				{ leftSplit, rightSplit } = workspace,
				// eslint-disable-next-line consistent-return
				leaf = ((): WorkspaceLeaf => {
					if (plugin.settings.createInstanceNearExistingOnes) {
						const existingLeaf = workspace
							.getLeavesOfType(TerminalView.type.namespaced(plugin))
							.at(-1)
						if (existingLeaf) {
							const root = existingLeaf.getRoot()
							if (root === leftSplit) {
								return workspace.getLeftLeaf(false)
							}
							if (root === rightSplit) {
								return workspace.getRightLeaf(false)
							}
							workspace.setActiveLeaf(existingLeaf)
							return workspace.getLeaf("tab")
						}
					}
					switch (plugin.settings.newInstanceBehavior) {
						case "replaceTab":
							return workspace.getLeaf()
						case "newTab":
							return workspace.getLeaf("tab")
						case "newLeftTab":
							return workspace.getLeftLeaf(false)
						case "newLeftSplit":
							return workspace.getLeftLeaf(true)
						case "newRightTab":
							return workspace.getRightLeaf(false)
						case "newRightSplit":
							return workspace.getRightLeaf(true)
						case "newHorizontalSplit":
							return workspace.getLeaf("split", "horizontal")
						case "newVerticalSplit":
							return workspace.getLeaf("split", "vertical")
						case "newWindow":
							return workspace.getLeaf("window")
						// No default
					}
				})()
			leaf.setPinned(plugin.settings.pinNewInstance)
			await leaf.setViewState({
				active: true,
				state: newCollabrativeState(plugin, new Map([
					[
						TerminalView.type,
						{
							cwd: cwd ?? null,
							profile,
							serial: null,
						} satisfies TerminalView.State,
					],
				])),
				type: TerminalView.type.namespaced(plugin),
			})
		} catch (error) {
			console.error(error)
		}
	})()
}
