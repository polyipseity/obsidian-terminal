import { FuzzySuggestModal } from "obsidian"
import { Platform } from "sources/utils/platforms"
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
				.isCompatible(item[1], Platform.CURRENT)
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
			await TerminalView.getLeaf(plugin).setViewState({
				active: true,
				state: newCollabrativeState(plugin, new Map([
					[
						TerminalView.type,
						{
							cwd: cwd ?? null,
							focus: plugin.settings.focusOnNewInstance,
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
