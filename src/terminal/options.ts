import type { Settings } from "../settings-data.js";
import { cloneDeep, isEqual } from "lodash-es";
import { cloneAsWritable } from "@polyipseity/obsidian-plugin-library";
import type { DeepWritable } from "ts-essentials";
import type { Terminal, ITerminalOptions } from "@xterm/xterm";

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
    macOptionIsMeta: false, // `false` is the default value, but set it explicitly for `CustomKeyEventHandlerAddon` to work just in case.
    ...cloneAsWritable(globalOpts, cloneDeep),
    ...cloneAsWritable(profileOpts, cloneDeep),
  };
}

/**
 * When global or profile terminal options change we need to patch the
 * underlying xterm `Terminal.options` object rather than recreating the
 * entire terminal.  This helper performs a *first-level* diff: it walks the
 * union of keys in the previous and current merged option sets, does a
 * deep equality check on each value, and applies only those entries that
 * differ.  Keys that have been removed are deleted from the target options
 * object.  Nested objects are compared recursively by `isEqual`, but we do
 * **not** descend into their properties when applying changes – the entire
 * value is assigned at once.
 *
 * @param terminal - xterm terminal whose `.options` property will be mutated
 * @param prevOpts - merged options computed before the change
 * @param curOpts - merged options computed after the change
 */
export function applyTerminalOptionDiffShallow(
  terminal: Terminal,
  prevOpts: ITerminalOptions,
  curOpts: ITerminalOptions,
): void {
  const allKeys = new Set<string>([
    ...Object.keys(prevOpts),
    ...Object.keys(curOpts),
  ]);
  for (const key of allKeys) {
    const prevVal = prevOpts[key as keyof typeof prevOpts];
    const curVal = curOpts[key as keyof typeof curOpts];
    if (!isEqual(prevVal, curVal)) {
      // assign a deep clone to avoid accidental shared references
      terminal.options[key as keyof typeof terminal.options] =
        cloneDeep(curVal);
    }
  }
}
