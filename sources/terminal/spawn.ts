import { FuzzySuggestModal, type WorkspaceLeaf } from "obsidian"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"
import { TerminalView } from "./view"
import { isUndefined } from "sources/utils/util"

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
		return Settings.Profile.nameOrID(item)
	}

	public override onChooseItem(
		item: Settings.Profile.Entry,
		_evt: KeyboardEvent | MouseEvent,
	): void {
		const { plugin, cwd } = this
		spawnTerminal(plugin, item[1], cwd)
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
				existingLeaves = workspace
					.getLeavesOfType(TerminalView.type.namespaced(plugin))
			await ((): WorkspaceLeaf => {
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
						cwd: cwd ?? null,
						profile,
						serial: null,
					} satisfies TerminalView.State,
					type: TerminalView.type.namespaced(plugin),
				})
		} catch (error) {
			console.error(error)
		}
	})()
}
