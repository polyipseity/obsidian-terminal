import type {
	ButtonComponent,
	DropdownComponent,
	ExtraButtonComponent,
	ValueComponent,
} from "obsidian"
import { inSet, isUndefined } from "sources/utils/util"
import type { Sized } from "sources/utils/types"
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
	getter: () => V,
	setter: (value: V, component: C, getter: () => V) => unknown,
	callback: (value: V, component: C, getter: () => V) => unknown,
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
			await callback(value, component, getter)
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
	icon: string,
	resetter: (component: C) => unknown,
	callback: (component: C) => unknown,
	action: ComponentAction<C, void> = {},
) {
	return (component: C): void => {
		(action.pre ?? ((): void => { }))(component)
		const activate = async (): Promise<void> => {
			const ret = await resetter(component)
			if (typeof ret === "boolean" && !ret) {
				return
			}
			await callback(component)
		}
		component
			.setTooltip(plugin.language.i18n.t("settings.reset"))
			.setIcon(icon)
			.onClick(activate);
		(action.post ?? ((): void => { }))(component, activate)
	}
}

export function dropdownSelect<V, C extends DropdownComponent>(
	unselected: string,
	selections: readonly {
		readonly name: string
		readonly value: V
	}[],
	callback: (value: V, component: C) => unknown,
	action: ComponentAction<C, string> = {},
) {
	return (component: C): void => {
		(action.pre ?? ((): void => { }))(component)
		const activate = async (value: string): Promise<void> => {
			const selection = selections[Number(value)]
			if (isUndefined(selection)) { return }
			component.setValue(NaN.toString())
			await callback(selection.value, component)
		}
		component
			.addOption(NaN.toString(), unselected)
			.addOptions(Object.fromEntries(selections
				.map((selection, index) => [index, selection.name])))
			.setValue(NaN.toString())
			.onChange(activate);
		(action.post ?? ((): void => { }))(component, activate)
	}
}
