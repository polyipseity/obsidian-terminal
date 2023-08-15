declare module "acorn" {
	// https://github.com/acornjs/acorn/issues/1136#issuecomment-1203671368
	type ExtendNode<T> =
		(T extends estree.Node
			? {
				start: number
				end: number
			} : unknown)
		& { [K in keyof T]: T[K] extends object ? ExtendNode<T[K]> : T[K] }
	function parse(s: string, o: Options): ExtendNode<estree.Program> & Node
}
import type { Node, Options } from "acorn"
import type estree from "estree"
