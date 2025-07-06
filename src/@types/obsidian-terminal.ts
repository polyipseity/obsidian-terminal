/**
 * Public API for `obsidian-terminal`.
 */
declare module "obsidian-terminal" {

	/**
	 * Type of `$$` in the developer console.
	 */
	interface DeveloperConsoleContext {

		/**
		 * Depth to expanded nested objects up to.
		 *
		 * @default 0
		 */
		depth: number

		/**
		 * Console history.
		 *
		 * The current command is added before its execution.
		 */
		readonly history: readonly string[]

		/**
		 * Console results and errors. Can be cleared.
		 *
		 * Result of the current command is added after its execution.
		 */
		readonly results: unknown[]

		/**
		 * Terminals connected to the developer console.
		 */
		readonly terminals: readonly Terminal[]
	}
}
import type { } from "obsidian-terminal"
import type { Terminal } from "@xterm/xterm"
