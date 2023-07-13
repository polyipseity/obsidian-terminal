/* eslint-disable @typescript-eslint/no-require-imports */
import {
	deepFreeze,
	typedKeys,
} from "@polyipseity/obsidian-plugin-library"

export const
	// Needed for bundler
	BUNDLE = deepFreeze({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"tmp-promise": (): unknown => require("tmp-promise"),
		xterm: (): unknown => require("xterm"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-canvas": (): unknown => require("xterm-addon-canvas"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-fit": (): unknown => require("xterm-addon-fit"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-ligatures": (): unknown => require("xterm-addon-ligatures"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-search": (): unknown => require("xterm-addon-search"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-serialize": (): unknown => require("xterm-addon-serialize"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-unicode11": (): unknown => require("xterm-addon-unicode11"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-web-links": (): unknown => require("xterm-addon-web-links"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-webgl": (): unknown => require("xterm-addon-webgl"),
	}),
	MODULES = typedKeys<readonly [
		"tmp-promise",
		"xterm",
		"xterm-addon-canvas",
		"xterm-addon-fit",
		"xterm-addon-ligatures",
		"xterm-addon-search",
		"xterm-addon-serialize",
		"xterm-addon-unicode11",
		"xterm-addon-web-links",
		"xterm-addon-webgl",
	]>()(BUNDLE)
