import {
  Platform,
  deopaque,
  dynamicRequire,
} from "@polyipseity/obsidian-plugin-library";

import { BUNDLE } from "../import.js";

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

/** Keys that belong to the parent app or multiplexer and should not leak
 *  into the embedded PTY. Their presence causes tools (e.g. Claude Code) to
 *  misdetect the terminal environment and enable incompatible rendering. */
export const SANITIZED_ENV_KEYS: ReadonlySet<string> = new Set([
  "TMUX",
  "STY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
]);
export const SANITIZED_ENV_PREFIXES: readonly string[] = ["VSCODE_", "ZED_"];

/** Lazily resolved system PATH queried from the OS.
 *
 *  GUI apps (Obsidian via Finder / Start Menu) often inherit a minimal PATH
 *  that is missing entries the user expects in a terminal.  We query the
 *  canonical system PATH once and merge it into the PTY environment.
 *
 *  - macOS:   /usr/libexec/path_helper -s  (reads /etc/paths + /etc/paths.d/*)
 *  - Linux:   reads /etc/environment (the PAM default)
 *  - Windows: reg query of the System + User PATH from the registry */
let systemPathPromise: Promise<string[]> | null = null;

function getSystemPath(): Promise<string[]> {
  if (!systemPathPromise) {
    systemPathPromise = resolveSystemPath();
  }
  return systemPathPromise;
}

async function resolveSystemPath(): Promise<string[]> {
  const platform = deopaque(Platform.CURRENT);
  try {
    const [childProcess2, process2] = await Promise.all([
      childProcess,
      process,
    ]);
    if (platform === "darwin") {
      // path_helper reads /etc/paths and /etc/paths.d/* (SIP-protected).
      // Call with empty PATH so it returns only system entries, not whatever
      // Obsidian inherited.
      const output = await execToString(
        childProcess2,
        "/usr/libexec/path_helper",
        ["-s"],
        { PATH: "" },
      );
      // Output format: PATH="entry1:entry2:..."; export PATH;
      const match = output.match(/PATH="([^"]*)"/);
      return match?.[1]?.split(":").filter(Boolean) ?? [];
    }
    if (platform === "linux") {
      // Try /etc/environment first (Debian/Ubuntu/PAM-based distros)
      const fsPromises2 = await fsPromises;
      try {
        const content = await fsPromises2.readFile("/etc/environment", "utf-8");
        const match = content.match(/^PATH="?([^"\n]*)"?/m);
        const entries = match?.[1]?.split(":").filter(Boolean) ?? [];
        if (entries.length > 0) {
          return entries;
        }
      } catch {
        // File doesn't exist (Arch, Alpine, Fedora, etc.) — try next
      }
      // Fall back to getconf PATH (POSIX, always available)
      try {
        const output = await execToString(childProcess2, "getconf", ["PATH"]);
        const entries = output.trim().split(":").filter(Boolean);
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
      const [systemOut, userOut] = await Promise.all([
        execToString(childProcess2, "reg", [
          "query",
          "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
          "/v",
          "Path",
        ]).catch(() => ""),
        execToString(childProcess2, "reg", [
          "query",
          "HKCU\\Environment",
          "/v",
          "Path",
        ]).catch(() => ""),
      ]);
      const extract = (out: string): string[] => {
        // reg output: "    Path    REG_SZ    value" or REG_EXPAND_SZ
        const match = out.match(/Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
        return match?.[1]?.trim().split(";").filter(Boolean) ?? [];
      };
      // Expand %SystemRoot% and similar using the current process env
      const expand = (p: string): string =>
        p.replace(/%([^%]+)%/g, (_, key: string) => process2.env[key] ?? "");
      const entries = [...extract(systemOut), ...extract(userOut)].map(expand);
      return entries;
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
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(cmd, args, {
      ...(env ? { env } : {}),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    proc.once("error", reject);
    proc.once("close", () => {
      resolve(out);
    });
  });
}

export async function sanitizedEnv(
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
  const entrySet = isWin
    ? new Set(entries.map((e) => e.toLowerCase()))
    : new Set(entries);
  const systemEntries = await getSystemPath();
  let modified = false;
  for (const entry of systemEntries) {
    const check = isWin ? entry.toLowerCase() : entry;
    if (!entrySet.has(check)) {
      entries.push(entry);
      entrySet.add(check);
      modified = true;
    }
  }
  if (modified) {
    env[pathKey] = entries.join(sep);
  }
  return env;
}
