import { describe, it, expect } from "vitest";

/**
 * These tests validate the regex patterns and parsing logic used in
 * `resolveSystemPath()` (pseudoterminal.ts) against realistic OS output.
 *
 * The functions under test are private, so we replicate the exact parsing
 * code here. Any change to the source patterns must be reflected here.
 */

// ── macOS: path_helper output ────────────────────────────────────────────

function parseDarwinPathHelper(output: string): string[] {
  const match = output.match(/PATH="([^"]*)"/);
  return match?.[1]?.split(":").filter(Boolean) ?? [];
}

describe("parseDarwinPathHelper", () => {
  it("parses standard path_helper -s output", () => {
    const output = `PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH;\n`;
    expect(parseDarwinPathHelper(output)).toEqual([
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);
  });

  it("parses output with Homebrew and custom paths.d entries", () => {
    const output = `PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Library/Apple/usr/bin:/Library/Frameworks/Mono.framework/Versions/Current/Commands"; export PATH;\n`;
    expect(parseDarwinPathHelper(output)).toEqual([
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/opt/homebrew/bin",
      "/Library/Apple/usr/bin",
      "/Library/Frameworks/Mono.framework/Versions/Current/Commands",
    ]);
  });

  it("returns empty array for empty PATH", () => {
    const output = `PATH=""; export PATH;\n`;
    expect(parseDarwinPathHelper(output)).toEqual([]);
  });

  it("returns empty array for unexpected output", () => {
    expect(parseDarwinPathHelper("some error message")).toEqual([]);
    expect(parseDarwinPathHelper("")).toEqual([]);
  });

  it("handles single entry", () => {
    const output = `PATH="/usr/bin"; export PATH;\n`;
    expect(parseDarwinPathHelper(output)).toEqual(["/usr/bin"]);
  });
});

// ── Linux: /etc/environment ──────────────────────────────────────────────

function parseLinuxEtcEnvironment(content: string): string[] {
  const match = content.match(/^PATH="?([^"\n]*)"?/m);
  return match?.[1]?.split(":").filter(Boolean) ?? [];
}

describe("parseLinuxEtcEnvironment", () => {
  it("parses quoted PATH from Ubuntu/Debian /etc/environment", () => {
    const content = `PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"\n`;
    expect(parseLinuxEtcEnvironment(content)).toEqual([
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
      "/usr/games",
      "/usr/local/games",
      "/snap/bin",
    ]);
  });

  it("parses unquoted PATH", () => {
    const content = `PATH=/usr/local/bin:/usr/bin:/bin\n`;
    expect(parseLinuxEtcEnvironment(content)).toEqual([
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  it("extracts PATH when other env vars are present", () => {
    const content = `LANG=en_US.UTF-8\nPATH="/usr/local/bin:/usr/bin"\nLOGNAME=foo\n`;
    expect(parseLinuxEtcEnvironment(content)).toEqual([
      "/usr/local/bin",
      "/usr/bin",
    ]);
  });

  it("returns empty array when PATH is missing", () => {
    const content = `LANG=en_US.UTF-8\nLOGNAME=foo\n`;
    expect(parseLinuxEtcEnvironment(content)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseLinuxEtcEnvironment("")).toEqual([]);
  });

  it("handles PATH at the first line", () => {
    const content = `PATH="/usr/bin:/bin"\nLANG=en_US.UTF-8\n`;
    expect(parseLinuxEtcEnvironment(content)).toEqual(["/usr/bin", "/bin"]);
  });
});

// ── Linux: getconf PATH fallback ─────────────────────────────────────────

function parseGetconfPath(output: string): string[] {
  return output.trim().split(":").filter(Boolean);
}

describe("parseGetconfPath", () => {
  it("parses standard getconf PATH output", () => {
    expect(parseGetconfPath("/usr/bin:/bin\n")).toEqual(["/usr/bin", "/bin"]);
  });

  it("handles trailing newline and spaces", () => {
    expect(parseGetconfPath("  /usr/bin:/bin  \n")).toEqual([
      "/usr/bin",
      "/bin",
    ]);
  });

  it("returns empty array for blank output", () => {
    expect(parseGetconfPath("")).toEqual([]);
    expect(parseGetconfPath("  \n")).toEqual([]);
  });
});

// ── Windows: registry query output ───────────────────────────────────────

function parseWindowsRegistryPath(out: string): string[] {
  const match = out.match(/Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
  return match?.[1]?.trim().split(";").filter(Boolean) ?? [];
}

function expandWindowsVars(p: string, env: Record<string, string>): string {
  return p.replace(/%([^%]+)%/g, (_, key: string) => env[key] ?? "");
}

describe("parseWindowsRegistryPath", () => {
  it("parses REG_EXPAND_SZ system PATH", () => {
    const output = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment
    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%;%SystemRoot%\\System32\\Wbem;%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\;C:\\Program Files\\Git\\cmd
`;
    expect(parseWindowsRegistryPath(output)).toEqual([
      "%SystemRoot%\\system32",
      "%SystemRoot%",
      "%SystemRoot%\\System32\\Wbem",
      "%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\",
      "C:\\Program Files\\Git\\cmd",
    ]);
  });

  it("parses REG_SZ user PATH", () => {
    const output = `
HKEY_CURRENT_USER\\Environment
    Path    REG_SZ    C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python311\\;C:\\Users\\dev\\.cargo\\bin
`;
    expect(parseWindowsRegistryPath(output)).toEqual([
      "C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python311\\",
      "C:\\Users\\dev\\.cargo\\bin",
    ]);
  });

  it("handles PATH (case-insensitive key) with REG_EXPAND_SZ", () => {
    const output = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment
    PATH    REG_EXPAND_SZ    C:\\Windows\\system32;C:\\Windows
`;
    expect(parseWindowsRegistryPath(output)).toEqual([
      "C:\\Windows\\system32",
      "C:\\Windows",
    ]);
  });

  it("returns empty array for empty/error output", () => {
    expect(parseWindowsRegistryPath("")).toEqual([]);
    expect(
      parseWindowsRegistryPath(
        "ERROR: The system was unable to find the specified registry key or value.",
      ),
    ).toEqual([]);
  });

  it("returns empty array when Path key is absent", () => {
    const output = `
HKEY_CURRENT_USER\\Environment
    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp
`;
    expect(parseWindowsRegistryPath(output)).toEqual([]);
  });
});

describe("expandWindowsVars", () => {
  const env = {
    SystemRoot: "C:\\Windows",
    SYSTEMROOT: "C:\\Windows",
    USERPROFILE: "C:\\Users\\dev",
  };

  it("expands %SystemRoot% variables", () => {
    expect(expandWindowsVars("%SystemRoot%\\system32", env)).toBe(
      "C:\\Windows\\system32",
    );
  });

  it("expands multiple variables in one string", () => {
    expect(expandWindowsVars("%SystemRoot%\\%USERPROFILE%", env)).toBe(
      "C:\\Windows\\C:\\Users\\dev",
    );
  });

  it("leaves unknown variables as empty strings", () => {
    expect(expandWindowsVars("%UNKNOWN_VAR%\\bin", env)).toBe("\\bin");
  });

  it("returns string unchanged when no variables", () => {
    expect(expandWindowsVars("C:\\Program Files\\Git\\cmd", env)).toBe(
      "C:\\Program Files\\Git\\cmd",
    );
  });
});

// ── PATH merging logic ───────────────────────────────────────────────────

function mergePathEntries(
  current: string[],
  system: string[],
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

describe("mergePathEntries", () => {
  it("appends missing entries", () => {
    expect(
      mergePathEntries(["/usr/bin"], ["/usr/bin", "/usr/local/bin"], false),
    ).toEqual(["/usr/bin", "/usr/local/bin"]);
  });

  it("preserves order of existing entries", () => {
    expect(mergePathEntries(["/a", "/b"], ["/c", "/a"], false)).toEqual([
      "/a",
      "/b",
      "/c",
    ]);
  });

  it("handles case-insensitive dedup on Windows", () => {
    expect(
      mergePathEntries(
        ["C:\\Windows\\System32"],
        ["c:\\windows\\system32", "C:\\New"],
        true,
      ),
    ).toEqual(["C:\\Windows\\System32", "C:\\New"]);
  });

  it("returns current entries unchanged when system is empty", () => {
    expect(mergePathEntries(["/usr/bin"], [], false)).toEqual(["/usr/bin"]);
  });

  it("returns system entries when current is empty", () => {
    expect(mergePathEntries([], ["/usr/bin", "/bin"], false)).toEqual([
      "/usr/bin",
      "/bin",
    ]);
  });
});

// ── env sanitization ─────────────────────────────────────────────────────

const SANITIZED_ENV_KEYS = new Set([
  "TMUX",
  "STY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
]);
const SANITIZED_ENV_PREFIXES = ["VSCODE_", "ZED_"];

function shouldSanitize(key: string): boolean {
  return (
    SANITIZED_ENV_KEYS.has(key) ||
    SANITIZED_ENV_PREFIXES.some((p) => key.startsWith(p))
  );
}

describe("env key sanitization", () => {
  it("strips TMUX", () => expect(shouldSanitize("TMUX")).toBe(true));
  it("strips STY", () => expect(shouldSanitize("STY")).toBe(true));
  it("strips TERM_PROGRAM", () =>
    expect(shouldSanitize("TERM_PROGRAM")).toBe(true));
  it("strips TERM_PROGRAM_VERSION", () =>
    expect(shouldSanitize("TERM_PROGRAM_VERSION")).toBe(true));
  it("strips VSCODE_ prefixed keys", () => {
    expect(shouldSanitize("VSCODE_GIT_ASKPASS_NODE")).toBe(true);
    expect(shouldSanitize("VSCODE_IPC_HOOK")).toBe(true);
  });
  it("strips ZED_ prefixed keys", () => {
    expect(shouldSanitize("ZED_TERM")).toBe(true);
  });
  it("keeps PATH", () => expect(shouldSanitize("PATH")).toBe(false));
  it("keeps HOME", () => expect(shouldSanitize("HOME")).toBe(false));
  it("keeps TERM", () => expect(shouldSanitize("TERM")).toBe(false));
  it("keeps SHELL", () => expect(shouldSanitize("SHELL")).toBe(false));
});
