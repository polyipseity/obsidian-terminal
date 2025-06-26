import { EditTerminalModal, TerminalView } from "./view.js"
import {
	Platform,
	getDefaultSuggestModalInstructions,
	revealPrivate,
} from "@polyipseity/obsidian-plugin-library"
import { FuzzySuggestModal } from "obsidian"
import { Settings } from "../settings-data.js"
import type { TerminalPlugin } from "../main.js"
import { noop } from "lodash-es"

export class SelectProfileModal
	extends FuzzySuggestModal<Settings.Profile.Entry | null> {
	public constructor(
		protected readonly context: TerminalPlugin,
		protected readonly cwd?: string,
	) {
		super(context.app)
		const { language: { value: i18n } } = context,
			instructions = getDefaultSuggestModalInstructions(context)
		this.setInstructions([
			...instructions.slice(0, -1),
			{
				get command(): string {
					return i18n
						.t("components.select-profile.instructions.edit-before-use")
				},
				get purpose(): string {
					return i18n

						.t("components.select-profile.instructions.edit-before-use-purpose")
				},
			},
			...instructions.slice(-1),
		])
		this.scope.register(null, "Enter", (evt): boolean => {
			if (evt.isComposing) { return true }
			revealPrivate(context, [this], this0 => {
				this0.selectActiveSuggestion(evt)
			}, noop)
			return false
		})
	}

	public override getItems(): (Settings.Profile.Entry | null)[] {
		return [null, ...Object.entries(this.context.settings.value.profiles)]
	}

	public override getItemText(item: Settings.Profile.Entry | null): string {
		const { context: { language: { value: i18n } } } = this
		if (item === null) {
			return i18n.t("components.select-profile.item-text-temporary")
		}
		return i18n.t(
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
		entry: Settings.Profile.Entry | null,
		evt: KeyboardEvent | MouseEvent,
	): void {
		const { context: plugin, cwd } = this
		spawnTerminal(
			plugin,
			entry?.[1] ?? Settings.Profile.DEFAULTS[""],
			{ cwd, edit: entry === null || evt.getModifierState("Control") },
		)
	}
}

export function spawnTerminal(
	context: TerminalPlugin,
	profile: Settings.Profile,
	options: {
		readonly cwd?: string | undefined,
		readonly edit?: boolean | undefined,
	} = {},
): void {
	const state: TerminalView.State = {
		cwd: options.cwd ?? null,
		focus: context.settings.value.focusOnNewInstance,
		profile,
		serial: null,
	}
	if (options.edit ?? false) {
		new EditTerminalModal(
			context,
			state,
			async state2 => TerminalView.spawn(context, state2),
		).open()
		return
	}
	(async (): Promise<void> => {
		try {
			await TerminalView.spawn(context, state)
		} catch (error) {
			self.console.error(error)
		}
	})()
}
