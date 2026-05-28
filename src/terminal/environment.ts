import {
  Platform,
  deopaque,
  dynamicRequire,
  lazyInit,
} from "@polyipseity/obsidian-plugin-library";

import {
  DEFAULT_PYTHONIOENCODING,
  TERM_PROGRAM,
  TERM_PROGRAM_VERSION,
} from "../magic.js";
import { BUNDLE } from "../import.js";
import { spawnPromise } from "../utils.js";

const childProcess = dynamicRequire<typeof import("node:child_process")>(
    BUNDLE,
    "node:child_process",
  ),
  fsPromises = dynamicRequire<typeof import("node:fs/promises")>(
    BUNDLE,
    "node:fs/promises",
  ),
  process = dynamicRequire<typeof import("node:process")>(
    BUNDLE,
    "node:process",
  );

export const SANITIZED_ENV_KEYS: ReadonlySet<string> = new Set([
  "TMUX",
  "TMUX_PANE",
  "STY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
]);
export const SANITIZED_ENV_PREFIXES: readonly string[] = ["VSCODE_", "ZED_"];

/** Fixed environment variables applied to all spawned processes.
 *
 *  Terminal/UI capabilities:
 *  - `COLORTERM: "truecolor"`: advertises true-color (24-bit) support; tools like
 *    Claude Code, neovim, and many TUIs probe this to enable full-color output.
 *  - `TERM: "xterm-256color"`: indicates 256-color xterm-compatible terminal support
 *    for Unix/Linux shells and terminal applications.
 *  - `TERM_PROGRAM`: identifies this as obsidian-terminal,
 *    replacing parent terminal identification (e.g., "iTerm", "vscode").
 *  - `TERM_PROGRAM_VERSION`: version identifier for compatibility checks.
 *
 *  Encoding:
 *  - `PYTHONIOENCODING`: ensures Python UTF-8 output with safe fallback handling.
 */
export const FIXED_ENV: Readonly<Record<string, string>> = {
  COLORTERM: "truecolor",
  PYTHONIOENCODING: DEFAULT_PYTHONIOENCODING,
  TERM: "xterm-256color",
  TERM_PROGRAM,
  TERM_PROGRAM_VERSION,
};

/** Fixed environment variables for external terminal emulators.
 *
 *  Currently empty as a placeholder. External terminals should use
 *  the system's inherited environment without plugin-specific overrides.
 */
export const FIXED_ENV_EXTERNAL: Readonly<Record<string, string>> = {};

/** Environment for system PATH discovery on macOS.
 *  Empty PATH ensures path_helper returns only system entries. */
export const DARWIN_PATH_HELPER_ENV: Readonly<Record<string, string>> = {
  PATH: "",
};

/** Applies fixed environment variables to a process environment.
 *  @param env the environment to augment
 *  @returns the same env object with fixed vars merged in */
export function applyFixedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.assign(env, FIXED_ENV);
}

/** Applies external terminal fixed environment variables to a process environment.
 *  @param env the environment to augment
 *  @returns the same env object with external fixed vars merged in */
export function applyFixedEnvExternal(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.assign(env, FIXED_ENV_EXTERNAL);
}

/** Parses the output of `/usr/libexec/path_helper -s` on macOS.
 *  Output format: `PATH="entry1:entry2:..."; export PATH;` */
export function parseDarwinPathHelper(output: string): string[] {
  const match = output.match(/PATH="([^"]*)"/);
  return match?.[1]?.split(":").filter(Boolean) ?? [];
}

/** Parses a `PATH` entry from `/etc/environment` (Debian/Ubuntu/PAM-based distros). */
export function parseEtcEnvironment(content: string): string[] {
  const match = content.match(/^PATH="?([^"\n]*)"?/m);
  return match?.[1]?.split(":").filter(Boolean) ?? [];
}

/** Parses the output of `getconf PATH` (POSIX fallback). */
export function parseGetconfOutput(output: string): string[] {
  return output.trim().split(":").filter(Boolean);
}

/** Parses `PATH` entries from `reg query` output on Windows.
 *  Handles both `REG_SZ` and `REG_EXPAND_SZ` value types. */
export function parseWindowsRegistryPath(output: string): string[] {
  const match = output.match(/Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
  return match?.[1]?.trim().split(";").filter(Boolean) ?? [];
}

/** Expands `%VAR%` patterns in a Windows path string using the given environment. */
export function expandWindowsVars(
  path: string,
  env: NodeJS.ProcessEnv,
): string {
  return path.replace(/%([^%]+)%/g, (_, key: string) => env[key] ?? "");
}

/** Merges `system` PATH entries into `current`, skipping duplicates.
 *  When `caseInsensitive` is `true` (Windows), comparison folds to lower-case. */
export function mergePathEntries(
  current: readonly string[],
  system: readonly string[],
  caseInsensitive: boolean,
): string[] {
  const entries = [...current];
  const entrySet = caseInsensitive
    ? new Set(entries.map((e) => e.toLowerCase()))
    : new Set(entries);
  for (const entry of system) {
    const check = caseInsensitive ? entry.toLowerCase() : entry;
    if (!entrySet.has(check)) {
      entries.push(entry);
      entrySet.add(check);
    }
  }
  return entries;
}

/** Lazily resolves the system PATH on first call.
 *
 *  GUI apps (Obsidian via Finder / Start Menu) often inherit a minimal PATH
 *  that is missing entries the user expects in a terminal.  We query the
 *  canonical system PATH once and merge it into the PTY environment.
 *
 *  - macOS:   /usr/libexec/path_helper -s  (reads /etc/paths + /etc/paths.d/*)
 *  - Linux:   reads /etc/environment (the PAM default)
 *  - Windows: reg query of the System + User PATH from the registry */
const getSystemPath = lazyInit(() => resolveSystemPath());

async function resolveSystemPath(): Promise<string[]> {
  const platform = deopaque(Platform.CURRENT);
  const process2 = await process;
  try {
    if (platform === "darwin") {
      // path_helper reads /etc/paths and /etc/paths.d/* (SIP-protected).
      // Call with empty PATH so it returns only system entries, not whatever
      // Obsidian inherited.
      const childProcess2 = await childProcess;
      const output = await execToString(
        childProcess2,
        "/usr/libexec/path_helper",
        ["-s"],
        DARWIN_PATH_HELPER_ENV,
      );
      return parseDarwinPathHelper(output);
    }
    if (platform === "linux") {
      // Try /etc/environment first (Debian/Ubuntu/PAM-based distros)
      const [childProcess2, fsPromises2] = await Promise.all([
        childProcess,
        fsPromises,
      ]);
      try {
        const content = await fsPromises2.readFile("/etc/environment", "utf-8");
        const entries = parseEtcEnvironment(content);
        if (entries.length > 0) {
          return entries;
        }
      } catch {
        // File doesn't exist (Arch, Alpine, Fedora, etc.) — try next
      }
      // Fall back to getconf PATH (POSIX, always available)
      try {
        const output = await execToString(
          childProcess2,
          "getconf",
          ["PATH"],
          process2.env,
        );
        const entries = parseGetconfOutput(output);
        if (entries.length > 0) {
          return entries;
        }
      } catch {
        // getconf not available
      }
      return [];
    }
    if (platform === "win32") {
      // Merge System and User PATH from the registry
      const childProcess2 = await childProcess;
      const [systemOut, userOut] = await Promise.all([
        execToString(
          childProcess2,
          "reg",
          [
            "query",
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            "/v",
            "Path",
          ],
          process2.env,
        ).catch(() => ""),
        execToString(
          childProcess2,
          "reg",
          ["query", "HKCU\\Environment", "/v", "Path"],
          process2.env,
        ).catch(() => ""),
      ]);
      return [
        ...parseWindowsRegistryPath(systemOut),
        ...parseWindowsRegistryPath(userOut),
      ].map((p) => expandWindowsVars(p, process2.env));
    }
  } catch {
    // If anything fails, the shell's own init files will still rebuild PATH.
  }
  return [];
}

async function execToString(
  cp: typeof import("node:child_process"),
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const proc = await spawnPromise(() =>
    cp.spawn(cmd, args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }),
  );
  return new Promise((resolve) => {
    let out = "";
    proc.stdout.on("data", (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    proc.once("close", () => {
      resolve(out);
    });
  });
}

/** Merges user-defined `[key, value]` pairs into an environment.
 *
 *  On Windows (and any platform where environment variable names are
 *  case-insensitive), any existing key in `env` that matches a user-defined
 *  key case-insensitively is removed *before* the new entries are applied.
 *  This is necessary because Node.js lexicographically sorts env keys and
 *  passes only the first case-insensitive match to the child process; without
 *  the removal the user-defined value could be shadowed.
 *
 *  Returns the same `env` object with the entries applied on top. */
export function applyProfileEnv(
  env: NodeJS.ProcessEnv,
  pairs: readonly (readonly [string, string])[],
): NodeJS.ProcessEnv {
  const userEnv = Object.fromEntries(pairs);
  const userKeys = Object.keys(userEnv);
  if (userKeys.length === 0) {
    return env;
  }
  if (Platform.CURRENT === "win32") {
    const upperKeys = new Set(userKeys.map((k) => k.toUpperCase()));
    for (const key of Object.keys(env)) {
      if (upperKeys.has(key.toUpperCase())) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete env[key];
      }
    }
  }
  return Object.assign(env, userEnv);
}

export async function sanitizeEnv(
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      SANITIZED_ENV_KEYS.has(key) ||
      SANITIZED_ENV_PREFIXES.some((p) => key.startsWith(p))
    ) {
      continue;
    }
    env[key] = value;
  }
  // Merge the canonical system PATH so tools installed in standard locations
  // are reachable even when Obsidian was launched with a minimal environment.
  const isWin = Platform.CURRENT === "win32";
  const sep = isWin ? ";" : ":";
  const pathKey = isWin
    ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path")
    : "PATH";
  const currentPath = env[pathKey] ?? "";
  const entries = currentPath.split(sep).filter(Boolean);
  const systemEntries = await getSystemPath();
  const merged = mergePathEntries(entries, systemEntries, isWin);
  if (merged.length > entries.length) {
    env[pathKey] = merged.join(sep);
  }
  return env;
}
