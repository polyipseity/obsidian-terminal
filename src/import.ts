/* eslint-disable @typescript-eslint/no-require-imports */
import { deepFreeze, typedKeys } from "@polyipseity/obsidian-plugin-library";

// Needed for bundler
const BUNDLE0 = deepFreeze({
  "@xterm/addon-canvas": (): unknown => require("@xterm/addon-canvas"),

  "@xterm/addon-fit": (): unknown => require("@xterm/addon-fit"),

  "@xterm/addon-ligatures": (): unknown => require("@xterm/addon-ligatures"),

  "@xterm/addon-search": (): unknown => require("@xterm/addon-search"),

  "@xterm/addon-serialize": (): unknown => require("@xterm/addon-serialize"),

  "@xterm/addon-unicode11": (): unknown => require("@xterm/addon-unicode11"),

  "@xterm/addon-web-links": (): unknown => require("@xterm/addon-web-links"),

  "@xterm/addon-webgl": (): unknown => require("@xterm/addon-webgl"),

  "@xterm/xterm": (): unknown => require("@xterm/xterm"),

  "tmp-promise": (): unknown => require("tmp-promise"),
});
export const // Needed for bundler
  BUNDLE = new Map(Object.entries(BUNDLE0)),
  MODULES =
    typedKeys<
      readonly [
        "@xterm/addon-canvas",
        "@xterm/addon-fit",
        "@xterm/addon-ligatures",
        "@xterm/addon-search",
        "@xterm/addon-serialize",
        "@xterm/addon-unicode11",
        "@xterm/addon-web-links",
        "@xterm/addon-webgl",
        "@xterm/xterm",
        "tmp-promise"
      ]
    >()(BUNDLE0);
