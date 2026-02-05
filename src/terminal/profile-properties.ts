import {
  type AnyObject,
  Platform,
  deepFreeze,
  launderUnchecked,
} from "@polyipseity/obsidian-plugin-library";
import {
  Pseudoterminal,
  RefPsuedoterminal,
  TextPseudoterminal,
} from "./pseudoterminal.js";
import {
  SUPPORTS_EXTERNAL_TERMINAL_EMULATOR,
  spawnExternalTerminalEmulator,
} from "./emulator.js";
import type { AsyncOrSync } from "ts-essentials";
import type { Settings } from "../settings-data.js";
import type { TerminalPlugin } from "../main.js";

export interface OpenOptions {
  readonly cwd?: string | undefined;
  readonly terminal?: string | undefined;
}
export const PROFILE_PROPERTIES: {
  readonly [key in Settings.Profile.Type]: {
    readonly available: boolean;
    readonly valid: boolean;
    readonly integratable: boolean;
    readonly opener: (
      context: TerminalPlugin,
      profile: Settings.Profile.Typed<key>,
      options?: OpenOptions
    ) => AsyncOrSync<RefPsuedoterminal<Pseudoterminal> | null>;
  };
} = deepFreeze({
  "": {
    available: true,
    integratable: true,
    opener() {
      return new RefPsuedoterminal(new TextPseudoterminal());
    },
    valid: true,
  },
  developerConsole: {
    available: true,
    integratable: true,
    async opener(context: TerminalPlugin) {
      return (await context.developerConsolePTY.onLoaded)().dup();
    },
    valid: true,
  },
  external: {
    available: SUPPORTS_EXTERNAL_TERMINAL_EMULATOR,
    integratable: false,
    async opener(
      _context: TerminalPlugin,
      profile: Settings.Profile.Typed<"external">,
      options?: OpenOptions
    ) {
      await spawnExternalTerminalEmulator(
        profile.executable,
        profile.args,
        options?.cwd
      );
      return null;
    },
    valid: true,
  },
  integrated: {
    available: Pseudoterminal.PLATFORM_PSEUDOTERMINAL !== null,
    integratable: true,
    opener(
      context: TerminalPlugin,
      profile: Settings.Profile.Typed<"integrated">,
      options?: OpenOptions
    ) {
      if (!Pseudoterminal.PLATFORM_PSEUDOTERMINAL) {
        return null;
      }
      const { args, platforms, useWin32Conhost, executable, pythonExecutable } =
          profile,
        supported = launderUnchecked<AnyObject>(platforms)[Platform.CURRENT];
      if (typeof supported !== "boolean" || !supported) {
        return null;
      }
      return new RefPsuedoterminal(
        new Pseudoterminal.PLATFORM_PSEUDOTERMINAL(context, {
          args,
          cwd: options?.cwd,
          executable,
          pythonExecutable: pythonExecutable || void 0,
          terminal: options?.terminal,
          useWin32Conhost,
        })
      );
    },
    valid: true,
  },
  invalid: {
    available: true,
    integratable: true,
    opener() {
      return null;
    },
    valid: false,
  },
});

export function openProfile<T extends Settings.Profile.Type>(
  context: TerminalPlugin,
  profile: Settings.Profile.Typed<T>,
  options?: OpenOptions
): AsyncOrSync<RefPsuedoterminal<Pseudoterminal> | null> {
  const type0: T = profile.type;
  return PROFILE_PROPERTIES[type0].opener(context, profile, options);
}
