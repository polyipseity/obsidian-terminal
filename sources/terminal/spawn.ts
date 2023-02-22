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
				{ workspace } = app
			// eslint-disable-next-line consistent-return
			await ((): WorkspaceLeaf => {
				if (plugin.settings.createInstanceNearExistingOnes) {
					const existingLeaf = workspace
						.getLeavesOfType(TerminalView.type.namespaced(plugin))
						.at(-1)
					if (existingLeaf) {
						workspace.setActiveLeaf(existingLeaf)
						return workspace.getLeaf("tab")
					}
				}
				switch (plugin.settings.newInstanceBehavior) {
					case "replaceTab":
						return workspace.getLeaf()
					case "newTab":
						return workspace.getLeaf("tab")
					case "newHorizontalSplit":
						return workspace.getLeaf("split", "horizontal")
					case "newVerticalSplit":
						return workspace.getLeaf("split", "vertical")
					case "newWindow":
						return workspace.getLeaf("window")
					// No default
				}
			})()
				.setViewState({
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
