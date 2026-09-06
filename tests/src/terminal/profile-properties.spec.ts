/**
 * Unit tests for `src/terminal/profile-properties.ts`.
 *
 * Covers:
 * - `resolveWin32Backend` for every configured backend and Python state
 * - the once-per-session ConPTY fallback notice and its reset helper
 * - `prewarmConPtyProfile` gating the spare on the Python check
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { TerminalPlugin } from "../../../src/main.js";
import type { Win32PythonDiagnosis } from "../../../src/terminal/win32-doctor.js";

const { checkWindowsPythonMock, notice2Spy } = vi.hoisted(() => ({
  checkWindowsPythonMock:
    vi.fn<
      (
        context: unknown,
        pythonExecutable: string,
        spawn?: unknown,
        options?: { readonly notify?: boolean },
      ) => Promise<Win32PythonDiagnosis>
    >(),
  notice2Spy:
    vi.fn<(message: () => string, timeout: number, context: unknown) => void>(),
}));

vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return { ...actual, notice2: notice2Spy };
});

vi.mock("../../../src/terminal/win32-doctor.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/terminal/win32-doctor.js")
    >();
  // The Python check spawns a real interpreter; the pure helpers stay.
  return { ...actual, checkWindowsPython: checkWindowsPythonMock };
});

import {
  CONPTY_HOST_POOL,
  ConPtyControlError,
} from "../../../src/terminal/pseudoterminal.js";
import { Settings } from "../../../src/settings-data.js";
import {
  conPtyFailureCondemnsRuntime,
  isConPtyRuntimeUnavailable,
  noticeWin32ConhostFallback,
  noticeWin32ResizerDisabled,
  reportConPtyRuntimeFailure,
  prewarmConPtyProfile,
  resetWin32FallbackNotice,
  resolveWin32Backend,
} from "../../../src/terminal/profile-properties.js";

/** A settings holder a test can replace, as the manager does on mutate. */
function settingsOf(pythonExecutable = ""): {
  value: {
    errorNoticeTimeout: number;
    prewarmConPty: boolean;
    pythonExecutable: string;
  };
} {
  return {
    value: { errorNoticeTimeout: 0, prewarmConPty: true, pythonExecutable },
  };
}

function context(
  pythonExecutable = "",
  settings = settingsOf(pythonExecutable),
): TerminalPlugin {
  return {
    language: { value: { t: (key: string): string => key } },
    register: vi.fn(),
    settings,
  } as unknown as TerminalPlugin;
}

function integratedProfile(
  overrides: Partial<Settings.Profile.Typed<"integrated">> = {},
): Settings.Profile.Typed<"integrated"> {
  return {
    ...Settings.Profile.DEFAULTS.integrated,
    // The test host reports `linux`; the profile has to accept it for the
    // gates after the platform check to run at all.
    platforms: { darwin: true, linux: true, win32: true },
    pythonExecutable: "python",
    win32Backend: "conpty",
    ...overrides,
  };
}

function diagnosis(
  overrides: Partial<Win32PythonDiagnosis> = {},
): Win32PythonDiagnosis {
  return {
    detail: "found 3.12.0 at C:\\Python312\\python.exe",
    executable: "C:\\Python312\\python.exe",
    status: "ok",
    version: "3.12.0",
    ...overrides,
  };
}

describe("resolveWin32Backend", () => {
  it("keeps ConPTY when Python is usable", () => {
    expect(resolveWin32Backend("conpty", true)).toBe("conpty");
  });

  it("degrades ConPTY to ConHost when Python is unusable", () => {
    expect(resolveWin32Backend("conpty", false)).toBe("legacy");
  });

  it("keeps an explicit legacy choice whatever Python reports", () => {
    expect(resolveWin32Backend("legacy", true)).toBe("legacy");
    expect(resolveWin32Backend("legacy", false)).toBe("legacy");
  });
});

describe("the ConPTY fallback notice", () => {
  afterEach(() => {
    resetWin32FallbackNotice();
    notice2Spy.mockClear();
  });

  it("explains the degraded backend once per session", () => {
    noticeWin32ConhostFallback(context(), "missing-python");
    noticeWin32ConhostFallback(context(), "missing-python");
    expect(notice2Spy).toHaveBeenCalledTimes(1);
    expect(notice2Spy.mock.calls[0]?.[0]()).toBe(
      "notices.win32-conhost-fallback",
    );
  });

  it("explains it again after the session guard is reset", () => {
    noticeWin32ConhostFallback(context(), "missing-python");
    resetWin32FallbackNotice();
    noticeWin32ConhostFallback(context(), "missing-python");
    expect(notice2Spy).toHaveBeenCalledTimes(2);
  });

  it("explains missing resizer packages once per session", () => {
    const cause = {
      pythonExecutable: "C:\\Python\\python.exe",
      reason: "packages-missing",
    } as const;
    noticeWin32ResizerDisabled(context(), cause);
    noticeWin32ResizerDisabled(context(), cause);
    expect(notice2Spy).toHaveBeenCalledTimes(1);
    expect(notice2Spy.mock.calls[0]?.[0]()).toBe(
      "notices.win32-resizer-packages-missing",
    );
  });

  it("explains a missing Python on ConHost without the ConPTY guidance", () => {
    noticeWin32ResizerDisabled(context(), {
      pythonExecutable: "python",
      reason: "python-missing",
    });
    expect(notice2Spy.mock.calls[0]?.[0]()).toBe(
      "notices.win32-resizer-python-missing",
    );
  });
});

describe("the ConPTY runtime circuit breaker", () => {
  afterEach(() => {
    resetWin32FallbackNotice();
    notice2Spy.mockClear();
  });

  it("starts closed and opens on a reported boot failure", () => {
    expect(isConPtyRuntimeUnavailable()).toBe(false);
    reportConPtyRuntimeFailure("python");
    expect(isConPtyRuntimeUnavailable()).toBe(true);
  });

  it("closes again with the session reset", () => {
    reportConPtyRuntimeFailure("python");
    resetWin32FallbackNotice();
    expect(isConPtyRuntimeUnavailable()).toBe(false);
  });

  it("explains a runtime fallback with the runtime message", () => {
    noticeWin32ConhostFallback(context(), "runtime-failure");
    expect(notice2Spy.mock.calls[0]?.[0]()).toBe(
      "notices.win32-conpty-runtime-fallback",
    );
  });

  it("shares one explanation budget across both causes", () => {
    noticeWin32ConhostFallback(context(), "runtime-failure");
    noticeWin32ConhostFallback(context(), "missing-python");
    expect(notice2Spy).toHaveBeenCalledTimes(1);
  });

  it("ignores exit 9009", () => {
    // Exit 9009 is "command not found": the shell is broken, not Python.
    expect(conPtyFailureCondemnsRuntime(new Error("exited"), 9009)).toBe(false);
  });

  it("ignores exit 251", () => {
    // Exit 251 is the host saying CreateProcessW failed for a reason other
    // than "not found" (access denied, bad working directory).
    expect(conPtyFailureCondemnsRuntime(new Error("exited"), 251)).toBe(false);
  });

  it("ignores a user abort", () => {
    expect(
      conPtyFailureCondemnsRuntime(new ConPtyControlError("aborted"), 1),
    ).toBe(false);
  });

  it("condemns the runtime for any other pre-ready death", () => {
    expect(conPtyFailureCondemnsRuntime(new Error("exited"), 1)).toBe(true);
    expect(
      conPtyFailureCondemnsRuntime(
        new ConPtyControlError("unauthenticated"),
        null,
      ),
    ).toBe(true);
  });
});

describe("prewarmConPtyProfile", () => {
  afterEach(() => {
    checkWindowsPythonMock.mockReset();
  });

  it("does nothing off Windows, before it reaches the Python check", async () => {
    await prewarmConPtyProfile(context(), integratedProfile());
    expect(checkWindowsPythonMock).not.toHaveBeenCalled();
  });
});

describe("prewarmConPtyProfile on Windows", () => {
  const prewarmOnWindows = async (
    ctx: TerminalPlugin,
    profile: Settings.Profile,
  ): Promise<void> => prewarmConPtyProfile(ctx, profile, { platform: "win32" });

  let ensureSpare: MockInstance<
    (typeof CONPTY_HOST_POOL)["ensureSpare"]
  > | null = null;

  beforeEach(() => {
    ensureSpare = vi
      .spyOn(CONPTY_HOST_POOL, "ensureSpare")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    ensureSpare?.mockRestore();
    ensureSpare = null;
    checkWindowsPythonMock.mockReset();
    notice2Spy.mockClear();
    resetWin32FallbackNotice();
  });

  it("boots one spare on the canonical interpreter when Python is usable", async () => {
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(context(), integratedProfile());
    expect(ensureSpare).toHaveBeenCalledTimes(1);
    expect(ensureSpare?.mock.calls[0]?.[0]).toBe("C:\\Python312\\python.exe");
  });

  it.each(["missing", "store-stub", "too-old"] as const)(
    "boots no spare when the Python check reports %s",
    async (status) => {
      checkWindowsPythonMock.mockResolvedValue(
        diagnosis({ executable: "python", status }),
      );
      await prewarmOnWindows(context(), integratedProfile());
      expect(ensureSpare).not.toHaveBeenCalled();
      expect(notice2Spy).not.toHaveBeenCalled();
    },
  );

  it("boots no spare when prewarm is switched off during the Python check", async () => {
    const settings = settingsOf();
    checkWindowsPythonMock.mockImplementation(async () => {
      // The settings manager replaces `value` on every mutation.
      settings.value = { ...settings.value, prewarmConPty: false };
      return diagnosis();
    });
    await prewarmOnWindows(context("", settings), integratedProfile());
    expect(checkWindowsPythonMock).toHaveBeenCalledTimes(1);
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it("boots no spare when the breaker trips during the Python check", async () => {
    checkWindowsPythonMock.mockImplementation(async () => {
      reportConPtyRuntimeFailure("python");
      return diagnosis();
    });
    await prewarmOnWindows(context(), integratedProfile());
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it("does not notify during prewarm", async () => {
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(context(), integratedProfile());
    expect(checkWindowsPythonMock.mock.calls[0]?.[3]).toEqual({
      notify: false,
    });
    expect(notice2Spy).not.toHaveBeenCalled();
  });

  it("skips the Python check for a profile that excludes this platform", async () => {
    await prewarmOnWindows(
      context(),
      integratedProfile({
        platforms: { darwin: false, linux: false, win32: false },
      }),
    );
    expect(checkWindowsPythonMock).not.toHaveBeenCalled();
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it("resolves an empty Python field through the chain, like the open path", async () => {
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
    // The empty value still probes: the candidate chain finds an interpreter.
    expect(checkWindowsPythonMock.mock.calls[0]?.[1]).toBe("");
    expect(ensureSpare).toHaveBeenCalledTimes(1);
    expect(ensureSpare?.mock.calls[0]?.[0]).toBe("C:\\Python312\\python.exe");
  });

  it("inherits the plugin-level Python setting into an empty profile field", async () => {
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(
      context("D:\\Tools\\python.exe"),
      integratedProfile({ pythonExecutable: "" }),
    );
    expect(checkWindowsPythonMock.mock.calls[0]?.[1]).toBe(
      "D:\\Tools\\python.exe",
    );
  });

  it("lets a non-empty profile field override the plugin-level setting", async () => {
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(
      context("D:\\Tools\\python.exe"),
      integratedProfile({ pythonExecutable: "C:\\Profile\\python.exe" }),
    );
    expect(checkWindowsPythonMock.mock.calls[0]?.[1]).toBe(
      "C:\\Profile\\python.exe",
    );
  });
});
