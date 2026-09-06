import {
  Platform,
  deepFreeze,
  inSet,
} from "@polyipseity/obsidian-plugin-library";
import { SemVer } from "semver";
import pythonRequirementsJson from "./python-requirements.json" with { type: "json" };

export interface PythonRequirement {
  /** Highest version the shipped helpers are known to work with. */
  readonly maximum: SemVer | undefined;
  readonly platforms: readonly Platform.All[];
  readonly version: SemVer;
}

function pythonRequirement(data: {
  readonly maximum?: string;
  readonly platforms: readonly string[];
  readonly version: string;
}): PythonRequirement {
  return {
    maximum: data.maximum === void 0 ? void 0 : new SemVer(data.maximum),
    platforms: data.platforms.filter((platform) =>
      inSet(Platform.ALL, platform),
    ),
    version: new SemVer(data.version),
  };
}

export const CHECK_EXECUTABLE_WAIT = 5,
  DEFAULT_ENCODING = "utf-8",
  DEFAULT_PYTHON_EXECUTABLE = "python3",
  DEFAULT_PYTHONIOENCODING = `${DEFAULT_ENCODING}:backslashreplace`,
  EXIT_SUCCESS = 0,
  DEFAULT_SUCCESS_EXIT_CODES = deepFreeze([
    EXIT_SUCCESS.toString(),
    "SIGINT",
    "SIGTERM",
  ]),
  MAX_HISTORY = 1024,
  MAX_LOCK_PENDING = Infinity,
  PLUGIN_UNLOAD_DELAY = 10,
  /** The interpreter itself under `Python`, then the manifest's packages. */
  PYTHON_REQUIREMENTS: Readonly<Record<string, PythonRequirement>> & {
    readonly Python: PythonRequirement;
  } = deepFreeze({
    // Minimum Python version (3.9 or above). Update README.md, dependabot.yml, magic.ts, pyproject.toml together.
    Python: pythonRequirement({
      platforms: Platform.DESKTOP,
      version: "3.9.0",
    }),
    ...Object.fromEntries(
      Object.entries(pythonRequirementsJson).map(([name, data]) => [
        name,
        pythonRequirement(data),
      ]),
    ),
  }),
  /** Seconds a profile's Python field must rest before its packages are
   * probed again. */
  PYTHON_PROBE_SETTLE_WAIT = 0.5,
  TERMINAL_EMULATOR_RESIZE_WAIT = 0.1,
  TERMINAL_EXIT_CLEANUP_WAIT = 5,
  /*
   * Flow-control geometry. The low water must stay above the write slice so
   * a resume fires while xterm still has parse work queued; a low water at or
   * below the slice size degenerates into resume-at-empty, which stalls the
   * producer and refills in bursts.
   */
  TERMINAL_OUTPUT_HIGH_WATER_BYTES = 131072,
  TERMINAL_OUTPUT_LOW_WATER_BYTES = 32768,
  TERMINAL_OUTPUT_WRITE_SLICE_BYTES = 8192,
  /*
   * Span (seconds) after a ConPTY resize during which output chunks skip
   * write slicing. conhost re-emits the whole viewport after a resize as one
   * large frame. Slicing that frame lets xterm paint between the slices,
   * which shows a torn, half-repainted screen with a hidden cursor on every
   * drag step. An unsliced frame parses as one uninterruptible unit, so
   * xterm paints it atomically. Node reads a pipe in blocks of at most
   * 65536 bytes, so one unsliced parse stays bounded.
   */
  TERMINAL_CONPTY_RESIZE_REPAINT_WINDOW = 0.5,
  /*
   * One throttle for every PTY backend; each applies a resize cheaply, and
   * the ConHost resizer serializes its passes. A shorter wait shrinks the
   * window where xterm and the PTY disagree about the width.
   */
  TERMINAL_PTY_RESIZE_WAIT = 0.1,
  /*
   * Delay after workspace layout-ready before booting a spare ConPTY host,
   * so the spare competes less with vault startup for CPU.
   */
  TERMINAL_CONPTY_PREWARM_DELAY = 5,
  /** Seconds a ConPTY control disconnect waits for the host's own exit
   * before it is reported as a handshake failure. */
  TERMINAL_CONPTY_HOST_EXIT_WAIT = 0.5,
  TERMINAL_RESIZER_WATCHDOG_WAIT = 0.5,
  TERM_PROGRAM = "obsidian-terminal",
  TERM_PROGRAM_VERSION = "0.0.0",
  WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe",
  WINDOWS_CONHOST_PATH = "C:\\Windows\\System32\\conhost.exe";

export namespace DOMClasses2 {
  export namespace Namespaced {
    export const TERMINAL = "terminal";
  }
  export const COLOR_PROBE = `${Namespaced.TERMINAL}:color-probe`,
    FULL_WIDTH = `${Namespaced.TERMINAL}:full-width`,
    HIDDEN = `${Namespaced.TERMINAL}:hidden`,
    LUCIDE_HEART = "lucide-heart",
    SETTING_ITEM = "setting-item",
    SETTING_ITEM_NAME = "setting-item-name",
    SVG_ICON = "svg-icon";
}

export namespace PluginUUIDs {
  export const UUID0 = "97fa8b23-8f64-4719-8cf5-630ea6e528d7";
}
