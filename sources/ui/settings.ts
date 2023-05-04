import type {
	ButtonComponent,
	DropdownComponent,
	ExtraButtonComponent,
	ValueComponent,
} from "obsidian"
import { inSet, instanceOf, unexpected } from "sources/utils/util"
import { DOMClasses } from "sources/magic"
import type { ReadonlyTuple } from "sources/utils/types"

export function closeSetting(container: HTMLElement): void {
	let element: HTMLElement | null = container
	while (element && !element.classList.contains(DOMClasses.MODAL)) {
		element = element.parentElement
	}
	const close = element?.querySelector(`.${DOMClasses.MODAL_CLOSE_BUTTON}`)
	if (instanceOf(close, HTMLElement)) { close.click() }
}

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
	{ pre, post }: ComponentAction<C, V> = {},
) {
	return (component: C): void => {
		if (pre) { pre(component) }
		const activate = async (value: V): Promise<void> => {
			const ret = await setter(value, component, getter)
			if (typeof ret === "boolean" && !ret) {
				component.setValue(getter())
				return
			}
			await callback(value, component, getter)
		}
		component.setValue(getter()).onChange(activate)
		if (post) { post(component, activate) }
	}
}

export function setTextToEnum<
	const Es extends ReadonlyTuple<V>,
	V,
	C extends ValueComponent<V>,
>(
	enums: Es,
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
		const num = value === "-" ? 0 : Number(value)
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
	icon: string,
	tooltip: string,
	resetter: (component: C) => unknown,
	callback: (component: C) => unknown,
	{ pre, post }: ComponentAction<C, void> = {},
) {
	return (component: C): void => {
		if (pre) { pre(component) }
		const activate = async (): Promise<void> => {
			const ret = await resetter(component)
			if (typeof ret === "boolean" && !ret) {
				return
			}
			await callback(component)
		}
		component
			.setIcon(icon)
			.setTooltip(tooltip)
			.onClick(activate)
		if (post) { post(component, activate) }
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
): (component: C) => void {
	return linkSetting(
		() => NaN.toString(),
		async (value, component) => {
			const selection = selections[Number(value)]
			if (selection) {
				await callback(selection.value, component)
			}
			return false
		},
		unexpected,
		{
			...action,
			pre(component) {
				component
					.addOption(NaN.toString(), unselected)
					.addOptions(Object.fromEntries(selections
						.map((selection, index) => [index, selection.name])))
				const { pre } = action
				if (pre) { pre(component) }
			},
		},
	)
}
