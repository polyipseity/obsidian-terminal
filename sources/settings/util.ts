import type {
	ButtonComponent,
	ExtraButtonComponent,
	ValueComponent,
} from "obsidian"
import { type Sized, inSet } from "sources/utils/util"
import { Settings } from "./data"
import type { TerminalPlugin } from "sources/main"

export interface ComponentAction<C, V> {
	readonly pre?: (component: C) => void
	readonly post?: (
		component: C,
		activate: (value: V) => PromiseLike<void>,
	) => void
}

export function linkSetting<
	V,
	C extends ValueComponent<V> & {
		readonly onChange: (
			callback: (value: V) => unknown) => C
	},
>(
	plugin: TerminalPlugin,
	getter: () => V,
	setter: (value: V, component: C, getter: () => V) => unknown,
	action: ComponentAction<C, V> = {},
) {
	return (component: C): void => {
		(action.pre ?? ((): void => { }))(component)
		const activate = async (value: V): Promise<void> => {
			const ret = await setter(value, component, getter)
			if (typeof ret === "boolean" && !ret) {
				component.setValue(getter())
				return
			}
			await Settings.save(plugin.settings, plugin)
		}
		component.setValue(getter()).onChange(activate);
		(action.post ?? ((): void => { }))(component, activate)
	}
}

export function setTextToEnum<
	Es extends readonly V[],
	V,
	C extends ValueComponent<V>,
>(
	enums: Sized<Es>,
	setter: (value: Es[number], component: C, getter: () => V) => unknown,
) {
	return async (
		value: V,
		component: C,
		getter: () => V,
	): Promise<boolean> => {
		if (!inSet(enums, value)) {
			return false
		}
		const ret = await setter(value, component, getter)
		if (typeof ret === "boolean" && !ret) {
			return false
		}
		return true
	}
}

export function setTextToNumber<C extends ValueComponent<string>>(
	setter: (value: number, component: C, getter: () => string) => unknown,
	integer = false,
) {
	return async (
		value: string,
		component: C,
		getter: () => string,
	): Promise<boolean> => {
		const num = Number(value)
		if (!(integer ? Number.isSafeInteger(num) : isFinite(num))) {
			return false
		}
		const ret = await setter(num, component, getter)
		if (typeof ret === "boolean" && !ret) {
			return false
		}
		return true
	}
}

export function resetButton<C extends ButtonComponent | ExtraButtonComponent>(
	plugin: TerminalPlugin,
	draw: () => unknown,
	resetter: (component: C) => unknown,
	icon?: string,
	action: ComponentAction<C, void> = {},
) {
	return (component: C): void => {
		(action.pre ?? ((): void => { }))(component)
		const activate = async (): Promise<void> => {
			const ret = await resetter(component)
			if (typeof ret === "boolean" && !ret) {
				return
			}
			await Promise.all([Settings.save(plugin.settings, plugin), draw()])
		}
		component
			.setTooltip(plugin.language.i18n.t("settings.reset"))
			.setIcon(icon ?? plugin.language.i18n.t("asset:settings.reset-icon"))
			.onClick(activate);
		(action.post ?? ((): void => { }))(component, activate)
	}
}
