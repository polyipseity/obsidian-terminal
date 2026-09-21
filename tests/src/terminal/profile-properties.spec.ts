/**
 * Unit tests for `src/terminal/profile-properties.ts`.
 *
 * Covers:
 * - `resolveWin32Backend` for every configured backend and Python state
 * - saved auto-demoted profiles recovering through `openProfile`
 * - `win32SpawnPythonExecutable` splitting the host and resizer interpreters
 * - the once-per-session ConPTY fallback notice and its reset helper
 * - `prewarmConPtyProfile` gating the spare on the Python check
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { TerminalPlugin } from "../../../src/main.js";
import type { Win32PythonDiagnosis } from "../../../src/terminal/win32-doctor.js";
import type { ShellPseudoterminalArguments } from "../../../src/terminal/pseudoterminal.js";

const {
  checkWindowsPythonMock,
  checkWindowsResizerPackagesMock,
  notice2Spy,
  platform,
} = vi.hoisted(() => ({
  platform: { windows: false },
  checkWindowsResizerPackagesMock:
    vi.fn<(pythonExecutable: string) => Promise<boolean>>(),
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
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get CURRENT() {
        return platform.windows ? "win32" : actual.Platform.CURRENT;
      },
    },
    notice2: notice2Spy,
  };
});

vi.mock("../../../src/terminal/win32-doctor.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/terminal/win32-doctor.js")
    >();
  // The Python check spawns a real interpreter; the pure helpers stay.
  return {
    ...actual,
    checkWindowsPython: checkWindowsPythonMock,
    checkWindowsResizerPackages: checkWindowsResizerPackagesMock,
  };
});

import {
  CONPTY_HOST_POOL,
  ConPtyControlError,
  Pseudoterminal,
  TextPseudoterminal,
} from "../../../src/terminal/pseudoterminal.js";
import { Settings } from "../../../src/settings-data.js";
import {
  clearWindowsPythonDiagnoses,
  isConPtyRuntimeUnavailable,
  runPluginPythonCheck,
} from "../../../src/terminal/win32-doctor.js";
import {
  conPtyFailureCondemnsRuntime,
  noticeWin32ConhostFallback,
  noticeWin32ResizerDisabled,
  openProfile,
  reportConPtyRuntimeFailure,
  prewarmConPtyProfile,
  resetWin32FallbackNotice,
  resolveWin32Backend,
  win32SpawnPythonExecutable,
} from "../../../src/terminal/profile-properties.js";

afterEach(() => {
  clearWindowsPythonDiagnoses();
});

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
  const executable = overrides.executable ?? "C:\\Python312\\python.exe";
  return {
    candidate: "python",
    detail: "found 3.12.0 at C:\\Python312\\python.exe",
    executable,
    // The host interpreter is the probed one unless a venv sits in between.
    hostExecutable: executable,
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

describe("openProfile with saved Windows backend choices", () => {
  const spawn = vi.fn<(args: ShellPseudoterminalArguments) => void>();
  const originalPty = Object.getOwnPropertyDescriptor(
    Pseudoterminal,
    "PLATFORM_PSEUDOTERMINAL",
  );

  class TestPseudoterminal extends TextPseudoterminal {
    // Backend selection needs a shell promise without starting a process.
    public readonly shell = new Promise<never>(() => {});
    public readonly win32Backend;

    public constructor(
      _context: TerminalPlugin,
      args: ShellPseudoterminalArguments,
    ) {
      super();
      this.win32Backend = args.win32Backend;
      spawn(args);
    }
  }

  const savedProfile = (autoDemoted = true): Settings.Profile =>
    Settings.Profile.fix(
      JSON.parse(
        JSON.stringify(
          integratedProfile({
            win32Backend: "legacy",
            win32BackendAutoDemoted: autoDemoted,
          }),
        ),
      ),
    ).value;

  beforeEach(() => {
    platform.windows = true;
    Object.defineProperty(Pseudoterminal, "PLATFORM_PSEUDOTERMINAL", {
      configurable: true,
      value: TestPseudoterminal,
    });
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    checkWindowsResizerPackagesMock.mockResolvedValue(true);
    vi.spyOn(self.console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalPty) {
      Object.defineProperty(
        Pseudoterminal,
        "PLATFORM_PSEUDOTERMINAL",
        originalPty,
      );
    }
    platform.windows = false;
    spawn.mockClear();
    checkWindowsPythonMock.mockReset();
    checkWindowsResizerPackagesMock.mockReset();
    notice2Spy.mockClear();
    resetWin32FallbackNotice();
    vi.restoreAllMocks();
  });

  it("recovers a restored auto-demoted tab and its restart when Python is healthy", async () => {
    const profile = savedProfile();
    const ctx = context();
    const restored = await openProfile(ctx, profile);
    await restored?.kill();
    const restarted = await openProfile(ctx, profile);
    await restarted?.kill();
    expect(spawn.mock.calls.map(([args]) => args.win32Backend)).toEqual([
      "conpty",
      "conpty",
    ]);
    expect(spawn.mock.calls[0]?.[0].pythonExecutable).toBe(
      "C:\\Python312\\python.exe",
    );
    expect(notice2Spy).not.toHaveBeenCalled();
    expect(checkWindowsResizerPackagesMock).not.toHaveBeenCalled();
    expect(profile).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
  });

  it("preserves an explicit saved legacy choice when Python is healthy", async () => {
    const pty = await openProfile(context(), savedProfile(false));
    await pty?.kill();
    expect(spawn.mock.calls[0]?.[0].win32Backend).toBe("legacy");
    expect(checkWindowsResizerPackagesMock).toHaveBeenCalledWith(
      "C:\\Python312\\python.exe",
    );
    expect(notice2Spy).not.toHaveBeenCalled();
  });

  it("retries ConPTY after a successful Python recheck", async () => {
    const ctx = Object.assign(context("python"), {
      settings: {
        value: { ...settingsOf("python").value, profiles: {} },
      },
    });
    reportConPtyRuntimeFailure("python");
    await (await openProfile(ctx, integratedProfile()))?.kill();
    await runPluginPythonCheck(
      ctx,
      vi.fn().mockResolvedValue({
        code: 0,
        stderr: "",
        stdout: "C:\\Python312\\python.exe\n3.12.0\n",
      }),
      vi.fn().mockResolvedValue(null),
    );
    await (await openProfile(ctx, integratedProfile()))?.kill();
    expect(spawn.mock.calls.map(([args]) => args.win32Backend)).toEqual([
      "legacy",
      "conpty",
    ]);
  });

  it("keeps another interpreter on ConPTY after one host fails", async () => {
    reportConPtyRuntimeFailure("broken-python");
    await (await openProfile(context(), integratedProfile()))?.kill();
    expect(spawn.mock.calls[0]?.[0].win32Backend).toBe("conpty");
    expect(checkWindowsResizerPackagesMock).not.toHaveBeenCalled();
  });

  it.each(["missing", "unconfirmed", "breaker"])(
    "keeps a saved auto-demoted tab on ConHost when the host is %s",
    async (failure) => {
      if (failure === "missing") {
        checkWindowsPythonMock.mockResolvedValue(
          diagnosis({ status: "missing", hostExecutable: null }),
        );
      } else if (failure === "unconfirmed") {
        checkWindowsPythonMock.mockResolvedValue(
          diagnosis({ hostExecutable: null, transient: true }),
        );
      } else {
        reportConPtyRuntimeFailure("python");
      }
      const pty = await openProfile(context(), savedProfile());
      await pty?.kill();
      expect(spawn.mock.calls[0]?.[0].win32Backend).toBe("legacy");
      expect(notice2Spy.mock.calls.map(([message]) => message())).toEqual(
        failure === "unconfirmed"
          ? []
          : [
              failure === "missing"
                ? "notices.win32-conhost-fallback"
                : "notices.win32-conpty-runtime-fallback",
            ],
      );
    },
  );
});

describe("win32SpawnPythonExecutable", () => {
  const venv = diagnosis({
    executable: "C:\\venv\\Scripts\\python.exe",
    hostExecutable: "C:\\Python312\\python.exe",
  });

  it("spawns the ConPTY host on the base interpreter behind a venv", () => {
    expect(win32SpawnPythonExecutable("conpty", venv)).toBe(
      "C:\\Python312\\python.exe",
    );
  });

  it("hands the ConHost resizer the venv that holds its packages", () => {
    expect(win32SpawnPythonExecutable("legacy", venv)).toBe(
      "C:\\venv\\Scripts\\python.exe",
    );
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
    expect(isConPtyRuntimeUnavailable("python")).toBe(false);
    reportConPtyRuntimeFailure("python");
    expect(isConPtyRuntimeUnavailable("python")).toBe(true);
  });

  it("closes again with the session reset", () => {
    reportConPtyRuntimeFailure("python");
    clearWindowsPythonDiagnoses();
    expect(isConPtyRuntimeUnavailable("python")).toBe(false);
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
    for (const error of [
      new ConPtyControlError("unauthenticated"),
      new ConPtyControlError("timeout"),
      new ConPtyControlError("disconnected"),
    ]) {
      expect(conPtyFailureCondemnsRuntime(error, null)).toBe(true);
    }
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

  it("boots no spare when the plugin unloads during its first Python check", async () => {
    // A fresh module gives this lifecycle test its own disposable pool.
    vi.resetModules();
    const { prewarmConPtyProfile: prewarm } =
        await import("../../../src/terminal/profile-properties.js"),
      { CONPTY_DEPENDENCIES, CONPTY_HOST_POOL: pool } =
        await import("../../../src/terminal/pseudoterminal.js"),
      createControl = vi
        .spyOn(CONPTY_DEPENDENCIES, "createDeferredControl")
        .mockRejectedValue(new Error("Unexpected spare boot")),
      register = vi.fn<(dispose: () => void) => void>(),
      ctx = Object.assign(context(), { register });
    let resolveCheck: (value: Win32PythonDiagnosis) => void = () => {};
    checkWindowsPythonMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    try {
      const pending = prewarm(ctx, integratedProfile(), { platform: "win32" });
      // Obsidian unload runs callbacks registered so far, not later ones.
      for (const [dispose] of register.mock.calls) dispose();
      resolveCheck(diagnosis());
      await pending;
      expect(createControl).not.toHaveBeenCalled();
    } finally {
      pool.dispose();
      createControl.mockRestore();
    }
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

  it("boots one spare on the resolved interpreter when Python is usable", async () => {
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(context(), integratedProfile());
    expect(ensureSpare).toHaveBeenCalledTimes(1);
    expect(ensureSpare?.mock.calls[0]?.[0]).toBe("C:\\Python312\\python.exe");
  });

  it("boots the spare on the base interpreter behind a venv, as the open path spawns it", async () => {
    const venv = diagnosis({
      executable: "C:\\venv\\Scripts\\python.exe",
      hostExecutable: "C:\\Python312\\python.exe",
    });
    checkWindowsPythonMock.mockResolvedValue(venv);
    await prewarmOnWindows(context(), integratedProfile());
    // The pool key has to be the value the open path acquires with, or the
    // spare is never reused.
    expect(ensureSpare?.mock.calls[0]?.[0]).toBe(
      win32SpawnPythonExecutable("conpty", venv),
    );
    expect(ensureSpare?.mock.calls[0]?.[0]).toBe("C:\\Python312\\python.exe");
  });

  it("boots no spare while no ConPTY host is confirmed", async () => {
    // The venv answered, its base interpreter's probe proved nothing: the
    // venv's launcher must not become a host.
    checkWindowsPythonMock.mockResolvedValue(
      diagnosis({
        executable: "C:\\venv\\Scripts\\python.exe",
        hostExecutable: null,
        transient: true,
      }),
    );
    await prewarmOnWindows(context(), integratedProfile());
    expect(ensureSpare).not.toHaveBeenCalled();
    expect(notice2Spy).not.toHaveBeenCalled();
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

  it("still prewarms an interpreter when another configuration failed", async () => {
    reportConPtyRuntimeFailure("broken-python");
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(context(), integratedProfile());
    expect(ensureSpare).toHaveBeenCalledTimes(1);
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
