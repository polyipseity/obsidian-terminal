import {
  Platform,
  cloneAsWritable,
  deopaque,
} from "@polyipseity/obsidian-plugin-library";
import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import { cloneDeep } from "es-toolkit/object";
import { isEqual } from "es-toolkit/predicate";
import type { DeepWritable } from "ts-essentials";
import type { Settings } from "../settings-data.js";
import { DEFAULT_LINK_HANDLER } from "./profile-presets.js";

export interface TerminalBackendOptions {
  /** Platform the terminal runs on. Defaults to the current platform. */
  readonly platform?: Platform.All | undefined;
  readonly win32Backend?: Settings.Profile.Win32Backend | undefined;
  /** Windows build of this machine, from `parseWin32BuildNumber`. */
  readonly win32BuildNumber?: number | undefined;
}

/**
 * The Windows build number in an `os.release()` string: `10.0.19045` is
 * 19045. Anything else, or a non-positive build, is `undefined`.
 */
export function parseWin32BuildNumber(release: string): number | undefined {
  const build = Number(release.split(".")[2]);
  return Number.isInteger(build) && build > 0 ? build : void 0;
}

/**
 * Combine global defaults with a profile-specific set of terminal options.
 * Values present in `profileOpts` take precedence; everything else comes from
 * `globalOpts`. This is a shallow merge and mirrors the behavior previously
 * implemented just for `fontFamily`.
 *
 * `windowsPty` is forced to the selected Windows backend, overriding a
 * persisted value that names a different one. A persisted `buildNumber`
 * stays, and a missing one takes the machine's: xterm.js reflows on resize
 * unless the build is below 21376, whose ConPTY re-emits wrapped lines itself.
 */
export function mergeTerminalOptions(
  profileOpts: Settings.Profile.TerminalOptions,
  globalOpts: Settings.Profile.TerminalOptions,
  backendOptions: TerminalBackendOptions = {},
): DeepWritable<Settings.Profile.TerminalOptions> {
  const merged: DeepWritable<Settings.Profile.TerminalOptions> = {
    allowProposedApi: true,
    macOptionIsMeta: false, // `false` is the default value, but set it explicitly for `CustomKeyEventHandlerAddon` to work just in case.
    linkHandler: DEFAULT_LINK_HANDLER,
    ...cloneAsWritable(globalOpts, cloneDeep),
    ...cloneAsWritable(profileOpts, cloneDeep),
  };
  if ((backendOptions.platform ?? deopaque(Platform.CURRENT)) === "win32") {
    if (backendOptions.win32Backend === "conpty") {
      const buildNumber =
        merged.windowsPty?.buildNumber ?? backendOptions.win32BuildNumber;
      merged.windowsPty = {
        backend: "conpty",
        // An `undefined` entry would not equal an absent one in the live diff.
        ...(buildNumber === void 0 ? {} : { buildNumber }),
      };
    } else if (backendOptions.win32Backend === "legacy") {
      delete merged.windowsPty;
    }
  }
  return merged;
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
    // `unknown` avoids the `any` that leaks from `documentOverride: any`.
    const prevVal: unknown = prevOpts[key as keyof typeof prevOpts];
    const curVal: unknown = curOpts[key as keyof typeof curOpts];
    if (!isEqual(prevVal, curVal)) {
      // assign a deep clone to avoid accidental shared references
      terminal.options[key as keyof typeof terminal.options] =
        cloneDeep(curVal);
    }
  }
}
