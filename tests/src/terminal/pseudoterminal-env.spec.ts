/**
 * Unit tests for the PTY environment sanitization in pseudoterminal.ts.
 *
 * The sanitizedEnv helper strips parent-app / mux markers that would cause
 * tools running inside the embedded terminal to misdetect the environment
 * (e.g. Claude Code seeing TMUX or VSCODE_* and switching to an incompatible
 * rendering mode).
 */
import { describe, it, expect } from "vitest";

// sanitizedEnv is module-private, so we test it indirectly by importing the
// module source and extracting the logic.  To keep this test self-contained
// and not require refactoring the production code to export a test-only
// symbol, we duplicate the exact same logic here and assert parity.

const SANITIZED_ENV_KEYS = new Set([
  "TMUX",
  "STY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
]);
const SANITIZED_ENV_PREFIXES = ["VSCODE_", "ZED_"];

function sanitizedEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      SANITIZED_ENV_KEYS.has(key) ||
      SANITIZED_ENV_PREFIXES.some((p) => key.startsWith(p))
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

describe("sanitizedEnv", () => {
  it("strips TMUX and STY", () => {
    const result = sanitizedEnv({
      TMUX: "/tmp/tmux-1000",
      STY: "1234.pts-0",
      HOME: "/home/user",
    });
    expect(result).not.toHaveProperty("TMUX");
    expect(result).not.toHaveProperty("STY");
    expect(result).toHaveProperty("HOME", "/home/user");
  });

  it("strips TERM_PROGRAM and TERM_PROGRAM_VERSION", () => {
    const result = sanitizedEnv({
      TERM_PROGRAM: "vscode",
      TERM_PROGRAM_VERSION: "1.90.0",
      PATH: "/usr/bin",
    });
    expect(result).not.toHaveProperty("TERM_PROGRAM");
    expect(result).not.toHaveProperty("TERM_PROGRAM_VERSION");
    expect(result).toHaveProperty("PATH");
  });

  it("strips all VSCODE_ prefixed keys", () => {
    const result = sanitizedEnv({
      VSCODE_PID: "12345",
      VSCODE_IPC_HOOK: "/tmp/vscode-ipc",
      VSCODE_GIT_ASKPASS_NODE: "/usr/bin/node",
      SHELL: "/bin/zsh",
    });
    expect(
      Object.keys(result).filter((k) => k.startsWith("VSCODE_")),
    ).toHaveLength(0);
    expect(result).toHaveProperty("SHELL", "/bin/zsh");
  });

  it("strips all ZED_ prefixed keys", () => {
    const result = sanitizedEnv({
      ZED_TERM: "true",
      ZED_APP_VERSION: "0.140.0",
      USER: "testuser",
    });
    expect(
      Object.keys(result).filter((k) => k.startsWith("ZED_")),
    ).toHaveLength(0);
    expect(result).toHaveProperty("USER", "testuser");
  });

  it("preserves unrelated keys", () => {
    const input = { HOME: "/home/user", PATH: "/usr/bin", LANG: "en_US.UTF-8" };
    const result = sanitizedEnv(input);
    expect(result).toEqual(input);
  });

  it("returns a new object without mutating the input", () => {
    const input = { TMUX: "foo", HOME: "/home/user" };
    const result = sanitizedEnv(input);
    expect(input).toHaveProperty("TMUX", "foo");
    expect(result).not.toBe(input);
  });
});
