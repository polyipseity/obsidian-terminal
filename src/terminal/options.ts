import type { Settings } from "../settings-data.js";
import { cloneDeep } from "lodash-es";
import { cloneAsWritable } from "@polyipseity/obsidian-plugin-library";
import type { DeepWritable } from "ts-essentials";

/**
 * Combine global defaults with a profile-specific set of terminal options.
 * Values present in `profileOpts` take precedence; everything else comes from
 * `globalOpts`. This is a shallow merge and mirrors the behavior previously
 * implemented just for `fontFamily`.
 */
export function mergeTerminalOptions(
  profileOpts: Settings.Profile.TerminalOptions,
  globalOpts: Settings.Profile.TerminalOptions,
): DeepWritable<Settings.Profile.TerminalOptions> {
  return {
    allowProposedApi: true,
    macOptionIsMeta: false, // `false` is the default value, but set it explicitly for `MacOSOptionKeyPassthroughAddon` to work just in case.
    ...cloneAsWritable(globalOpts, cloneDeep),
    ...cloneAsWritable(profileOpts, cloneDeep),
  };
}
