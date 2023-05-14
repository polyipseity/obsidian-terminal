import { Platform, newCollabrativeState } from "obsidian-plugin-library"
import { FuzzySuggestModal } from "obsidian"
import { Settings } from "../settings-data.js"
import type { TerminalPlugin } from "../main.js"
import { TerminalView } from "./view.js"

export class SelectProfileModal
	extends FuzzySuggestModal<Settings.Profile.Entry> {
	public constructor(
		protected readonly context: TerminalPlugin,
		protected readonly cwd?: string,
	) {
		super(context.app)
	}

	public override getItems(): Settings.Profile.Entry[] {
		return Object.entries(this.context.settings.copy.profiles)
	}

	public override getItemText(item: Settings.Profile.Entry): string {
		return this.context.language.i18n.t(
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
		const { context: plugin, cwd } = this
		spawnTerminal(plugin, profile, cwd)
	}
}

export function spawnTerminal(
	context: TerminalPlugin,
	profile: Settings.Profile,
	cwd?: string,
): void {
	(async (): Promise<void> => {
		try {
			await TerminalView.getLeaf(context).setViewState({
				active: true,
				state: newCollabrativeState(context, new Map([
					[
						TerminalView.type,
						{
							cwd: cwd ?? null,
							focus: context.settings.copy.focusOnNewInstance,
							profile,
							serial: null,
						} satisfies TerminalView.State,
					],
				])),
				type: TerminalView.type.namespaced(context),
			})
		} catch (error) {
			self.console.error(error)
		}
	})()
}
