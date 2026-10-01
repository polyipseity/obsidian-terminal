/**
 * Unit tests for `src/terminal/profile-properties.ts`.
 *
 * Covers:
 * - `resolveWin32Backend` for every configured backend and Python state
 * - saved backend choices and runtime fallback through `openProfile`
 * - `win32SpawnPythonExecutable` splitting the host and resizer interpreters
 * - the once-per-session ConPTY fallback notice and its reset helper
 * - `prewarmConPtyProfile` gating the spare on the Python check
 */
import { createInstance } from "i18next";
import { Storage } from "happy-dom";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  SI_PREFIX_SCALE,
  StorageSettingsManager,
} from "@polyipseity/obsidian-plugin-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../assets/locales/en/translation.json" with { type: "json" };
import type { MockInstance } from "vitest";
import type { TerminalPlugin } from "../../../src/main.js";
import type {
  checkWindowsPython,
  Win32PythonDiagnosis,
  Win32PythonSpawn,
} from "../../../src/terminal/win32-doctor.js";
import {
  TERMINAL_EXIT_CLEANUP_WAIT,
  WINDOWS_CONHOST_PATH,
} from "../../../src/magic.js";
import {
  spawnExternalTerminalEmulator,
  XtermTerminalEmulator,
} from "../../../src/terminal/emulator.js";
import { tick } from "../../support/helpers.js";
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
  checkWindowsPythonMock: vi.fn<typeof checkWindowsPython>(),
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

vi.mock("../../../src/terminal/emulator.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/terminal/emulator.js")
  >()),
  spawnExternalTerminalEmulator: vi.fn().mockResolvedValue(void 0),
}));

// The build loads Python source as a lazy promise; Vitest treats it as an asset URL.
vi.mock("../../../src/terminal/win32_conpty.py", () => ({
  default: Promise.resolve("test host"),
}));

import {
  CONPTY_DEPENDENCIES,
  CONPTY_HOST_POOL,
  ConPtyControlError,
  ConPtySetupError,
  type ConPtyReadyEvent,
  Pseudoterminal,
  RefPsuedoterminal,
  TextPseudoterminal,
  WindowsNamedPipeControlChannel,
} from "../../../src/terminal/pseudoterminal.js";
import { LocalSettings, Settings } from "../../../src/settings-data.js";
import { PROFILE_PRESETS } from "../../../src/terminal/profile-presets.js";
import {
  clearWindowsPythonDiagnoses,
  invalidateConPtyRuntime,
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
    executable: "C:\\Windows\\System32\\cmd.exe",
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
    tried: ["python"],
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

  // Each test controls the public shell-start boundary without spawning a process.
  let shellStart = Promise.withResolvers<undefined>();
  let conhostExit = Promise.withResolvers<number>();
  const graceMs = TERMINAL_EXIT_CLEANUP_WAIT * SI_PREFIX_SCALE;

  class TestPseudoterminal extends TextPseudoterminal {
    public readonly shell = shellStart.promise;

    public override async kill(): Promise<void> {
      shellStart.reject(new ConPtyControlError("aborted"));
      await super.kill();
    }
    public readonly win32Backend;

    public constructor(
      _context: TerminalPlugin,
      args: ShellPseudoterminalArguments,
    ) {
      super();
      this.shell.catch(() => void 0);
      this.win32Backend = args.win32Backend;
      spawn(args);
    }
  }

  // ConHost spawn fulfils shell before the configured command starts. A kill
  // waits for that spawn and settles onExit without rejecting shell.
  class TestConHostPseudoterminal extends TestPseudoterminal {
    public override readonly onExit = conhostExit.promise;

    public override async kill(): Promise<void> {
      await this.shell;
      conhostExit.resolve(0);
    }
  }

  function profileForBackend(backend: string) {
    if (backend !== "conpty") {
      Object.defineProperty(Pseudoterminal, "PLATFORM_PSEUDOTERMINAL", {
        configurable: true,
        value: TestConHostPseudoterminal,
      });
    }
    if (backend === "fallback") {
      checkWindowsPythonMock.mockResolvedValue(
        diagnosis({ status: "missing", hostExecutable: null }),
      );
    }
    return integratedProfile({
      win32Backend: backend === "legacy" ? "legacy" : "conpty",
    });
  }

  const savedProfile = (
    win32Backend: Settings.Profile.Win32Backend = "conpty",
  ): Settings.Profile =>
    Settings.Profile.fix(
      JSON.parse(JSON.stringify(integratedProfile({ win32Backend }))),
    ).value;

  beforeEach(() => {
    shellStart = Promise.withResolvers<undefined>();
    conhostExit = Promise.withResolvers<number>();
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
    vi.useRealTimers();
    vi.mocked(spawnExternalTerminalEmulator).mockClear();
    spawn.mockClear();
    checkWindowsPythonMock.mockReset();
    checkWindowsResizerPackagesMock.mockReset();
    notice2Spy.mockClear();
    resetWin32FallbackNotice();
    vi.restoreAllMocks();
  });

  it.each(
    ["warm", "cold", "ConHost"].flatMap((path) =>
      [{ "": "" }, { "": "", VALID: "kept" }].map((environment) => ({
        path,
        environment,
      })),
    ),
  )(
    "opens $path with $environment without passing an empty name or blaming Python",
    async ({ path, environment }) => {
      Object.defineProperty(Pseudoterminal, "PLATFORM_PSEUDOTERMINAL", {
        configurable: true,
        value: Pseudoterminal.PLATFORM_PSEUDOTERMINALS.win32,
      });
      const ctx = Object.assign(context(), {
          localSettings: { value: { hasUsedIntegratedTerminal: true } },
        }),
        nativeSpawn = childProcess.spawn.bind(childProcess),
        children: ReturnType<typeof nativeSpawn>[] = [],
        startHost = () => {
          const host = nativeSpawn(
            process.execPath,
            ["-e", "process.stdin.resume();"],
            {
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          children.push(host);
          return host;
        },
        server = createServer();
      // Exercise the shipped Windows backends without opening a named pipe.
      vi.spyOn(server, "listen").mockImplementation(() => {
        server.emit("listening");
        return server;
      });
      const control = await WindowsNamedPipeControlChannel.create({
          createServer: vi.fn(() => server),
          deferred: true,
          pipePath: vi.fn(() => "test-control-pipe"),
          randomUUID,
        }),
        ready = Promise.withResolvers<ConPtyReadyEvent>(),
        acceptHost = (host: ReturnType<typeof startHost>): void => {
          if (!host.pid) throw new Error("Test host has no PID");
          ready.resolve({
            attestation:
              "create-pseudoconsole+authenticated-control-channel+job-object-assigned",
            childPid: host.pid + 1,
            controlChannelAuthenticated: true,
            createPseudoConsole: true,
            event: "ready",
            hostPid: host.pid,
            jobObjectAssigned: true,
          });
        },
        warmHost = path === "warm" ? startHost() : null,
        start = vi.spyOn(control, "start").mockImplementation(async () => {
          if (warmHost) acceptHost(warmHost);
        }),
        spawnHost = vi
          .spyOn(CONPTY_DEPENDENCIES, "spawn")
          .mockImplementation(async (_executable, _args, options) => {
            if (Object.hasOwn(options.env, "")) throw new Error("spawn EINVAL");
            const host = startHost();
            acceptHost(host);
            return host;
          }),
        spawnProcess = vi
          .spyOn(childProcess, "spawn")
          .mockImplementation((_executable, _args, options) => {
            // Registry queries return no entries; ConHost and its resizer live
            // until cleanup, with the resizer exiting when stdin closes.
            const child = nativeSpawn(
              process.execPath,
              ["-e", _executable === "reg" ? "" : "process.stdin.resume();"],
              options,
            );
            children.push(child);
            return child;
          });
      Object.assign(control, { ready: ready.promise });
      vi.spyOn(control, "kill").mockImplementation(async () => {
        for (const child of children) child.kill();
      });
      vi.spyOn(CONPTY_DEPENDENCIES, "createControl").mockResolvedValue(control);
      vi.spyOn(CONPTY_DEPENDENCIES, "materializeSource").mockResolvedValue(
        "test-host.py",
      );
      vi.spyOn(CONPTY_HOST_POOL, "acquire").mockReturnValue(
        warmHost
          ? { control, host: warmHost, generation: CONPTY_HOST_POOL.generation }
          : null,
      );
      vi.spyOn(CONPTY_HOST_POOL, "release").mockImplementation(() => {});
      vi.spyOn(CONPTY_HOST_POOL, "ensureSpare").mockImplementation(() => {});
      const profile = integratedProfile({
        environment: Object.entries(environment),
        win32Backend: path === "ConHost" ? "legacy" : "conpty",
      });
      let pty: RefPsuedoterminal<Pseudoterminal> | null = null;
      try {
        pty = await openProfile(ctx, profile);
        expect(pty).not.toBeNull();
        await pty?.shell;
        await tick();
        expect(start).toHaveBeenCalledTimes(path === "warm" ? 1 : 0);
        expect(spawnHost).toHaveBeenCalledTimes(path === "cold" ? 1 : 0);
        const launchEnv =
          path === "warm"
            ? start.mock.calls[0]?.[0].env
            : path === "cold"
              ? spawnHost.mock.calls[0]?.[2].env
              : spawnProcess.mock.calls.find(
                  ([executable]) => executable === WINDOWS_CONHOST_PATH,
                )?.[2]?.env;
        expect(launchEnv).toBeDefined();
        expect(Object.keys(launchEnv ?? {})).not.toContain("");
        if ("VALID" in environment) expect(launchEnv?.VALID).toBe("kept");
        for (const [, , options] of spawnProcess.mock.calls)
          expect(Object.keys(options.env ?? {})).not.toContain("");
        expect(notice2Spy).not.toHaveBeenCalled();
        expect(isConPtyRuntimeUnavailable("python")).toBe(false);
        expect(profile.environment).toEqual(Object.entries(environment));
      } finally {
        await pty?.kill().catch(() => {});
        await pty?.onExit.catch(() => {});
        for (const child of children) child.kill();
        await control.dispose();
      }
      expect(notice2Spy).not.toHaveBeenCalled();
      expect(isConPtyRuntimeUnavailable("python")).toBe(false);
    },
  );

  it("rejects an empty executable without touching Python, the pool or the breaker", async () => {
    const ctx = context(),
      translate = vi
        .spyOn(ctx.language.value, "t")
        .mockReturnValue("Localized empty executable error"),
      acquire = vi.spyOn(CONPTY_HOST_POOL, "acquire"),
      clear = vi.spyOn(CONPTY_HOST_POOL, "clear"),
      refill = vi.spyOn(CONPTY_HOST_POOL, "ensureSpare");
    expect(isConPtyRuntimeUnavailable("python")).toBe(false);

    await expect(
      openProfile(ctx, integratedProfile({ executable: "" })),
    ).rejects.toThrow("Localized empty executable error");

    expect(translate).toHaveBeenCalledWith("errors.profile-executable-empty");
    expect(checkWindowsPythonMock).not.toHaveBeenCalled();
    expect(checkWindowsResizerPackagesMock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(refill).not.toHaveBeenCalled();
    expect(isConPtyRuntimeUnavailable("python")).toBe(false);

    await (await openProfile(ctx, integratedProfile()))?.kill();
    expect(spawn.mock.calls.map(([args]) => args.win32Backend)).toEqual([
      "conpty",
    ]);
  });

  it.each(["missing", "unconfirmed", "breaker"])(
    "cancels a %s fallback when closed during Python diagnosis",
    async (failure) => {
      const pending = Promise.withResolvers<Win32PythonDiagnosis>(),
        result = diagnosis({
          status: failure === "missing" ? "missing" : "ok",
          hostExecutable: failure === "breaker" ? "python" : null,
          transient: failure === "unconfirmed",
        }),
        { ctx, localSettings, mutate, write } = await localContext();
      if (failure === "breaker") reportConPtyRuntimeFailure("python");
      checkWindowsPythonMock.mockReturnValueOnce(pending.promise);
      const emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        async (_terminal, _addons, signal) => {
          const pty = await openProfile(ctx, integratedProfile(), { signal });
          if (!pty) throw new Error("Expected an integrated pseudoterminal");
          return pty;
        },
      );
      await tick();
      expect(checkWindowsPythonMock).toHaveBeenCalledOnce();
      const closing = emulator.close(true);
      pending.resolve(result);
      try {
        await expect(closing).resolves.toBeUndefined();
        expect(notice2Spy).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        expect(checkWindowsResizerPackagesMock).not.toHaveBeenCalled();
        await expect(emulator.pseudoterminal).rejects.toMatchObject({
          reason: "aborted",
        });
        expect(localSettings.value.hasUsedIntegratedTerminal).toBe(false);
        expect(mutate).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        // A cancelled open must not consume the later live fallback's notice.
        checkWindowsPythonMock.mockResolvedValueOnce(result);
        await (await openProfile(ctx, integratedProfile()))?.kill();
        expect(notice2Spy).toHaveBeenCalledTimes(
          failure === "unconfirmed" ? 0 : 1,
        );
      } finally {
        await closing.catch(vi.fn());
        localSettings.unload();
      }
    },
  );

  it("rejects an already cancelled open before the POSIX-path notice or Python check", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openProfile(
        context(),
        integratedProfile({ pythonExecutable: "/opt/python3" }),
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(notice2Spy).not.toHaveBeenCalled();
    expect(checkWindowsPythonMock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "cancels after a pending resizer check (packages available: %s)",
    async (packagesAvailable) => {
      const pending = Promise.withResolvers<boolean>(),
        controller = new AbortController();
      checkWindowsPythonMock.mockResolvedValueOnce(
        diagnosis({ hostExecutable: null, transient: true }),
      );
      checkWindowsResizerPackagesMock.mockReturnValueOnce(pending.promise);
      const opening = openProfile(context(), integratedProfile(), {
        signal: controller.signal,
      });
      await tick();
      expect(checkWindowsResizerPackagesMock).toHaveBeenCalledOnce();
      controller.abort();
      pending.resolve(packagesAvailable);
      await expect(opening).rejects.toMatchObject({ reason: "aborted" });
      expect(notice2Spy).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("forwards the pool generation captured before a pending Python diagnosis", async () => {
    const pending = Promise.withResolvers<Win32PythonDiagnosis>(),
      generation = CONPTY_HOST_POOL.generation;
    checkWindowsPythonMock.mockReturnValueOnce(pending.promise);
    const opening = openProfile(context(), integratedProfile());
    expect(checkWindowsPythonMock).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    CONPTY_HOST_POOL.clear();
    pending.resolve(diagnosis());
    const pty = await opening;
    try {
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ conPtyPoolGeneration: generation }),
      );
    } finally {
      await pty?.kill();
    }
  });

  async function localContext() {
    const ctx = Object.assign(context(), {
      app: { appId: "local-use-test" },
      manifest: { id: "terminal-test" },
      language: {
        value: { t: (key: string): string => key },
        onLoaded: Promise.resolve(),
      },
    });
    const storage = new Storage(),
      localSettings = new StorageSettingsManager(
        ctx,
        LocalSettings.fix,
        storage,
      );
    Object.assign(ctx, { localSettings });
    localSettings.load();
    await localSettings.onLoaded;
    await localSettings.write();
    const mutate = vi.spyOn(localSettings, "mutate"),
      write = vi.spyOn(localSettings, "write"),
      syncedMutate = vi.fn(),
      syncedWrite = vi.fn();
    Object.assign(ctx.settings, { mutate: syncedMutate, write: syncedWrite });
    return {
      ctx,
      localSettings,
      storage,
      mutate,
      write,
      syncedMutate,
      syncedWrite,
    };
  }

  it.each(["conpty", "legacy", "fallback"])(
    "records successful %s shell starts locally once",
    async (backend) => {
      vi.useFakeTimers();
      const profile = profileForBackend(backend);
      const {
        ctx,
        localSettings,
        storage,
        mutate,
        write,
        syncedMutate,
        syncedWrite,
      } = await localContext();
      const pty = await openProfile(ctx, profile);
      expect(pty).not.toBeNull();
      expect(localSettings.value.hasUsedIntegratedTerminal).toBe(false);
      expect(write).not.toHaveBeenCalled();
      shellStart.resolve(void 0);
      await vi.advanceTimersByTimeAsync(0);
      if (backend !== "conpty") {
        await vi.advanceTimersByTimeAsync(graceMs - 1);
        expect(mutate).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(write).toHaveBeenCalledTimes(1);
      await write.mock.results[0]?.value;
      expect(spawn.mock.calls[0]?.[0].win32Backend).toBe(
        backend === "conpty" ? "conpty" : "legacy",
      );
      const stored: unknown = JSON.parse(
        storage.getItem("local-use-test.terminal-test.settings") ?? "null",
      );
      expect(LocalSettings.fix(stored).value.hasUsedIntegratedTerminal).toBe(
        true,
      );
      await (await openProfile(ctx, profile))?.kill();
      await vi.advanceTimersByTimeAsync(graceMs);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(syncedMutate).not.toHaveBeenCalled();
      expect(syncedWrite).not.toHaveBeenCalled();
      expect(ctx.settings.value).not.toHaveProperty(
        "hasUsedIntegratedTerminal",
      );
      await pty?.kill();
      localSettings.unload();
    },
  );

  describe.each(["legacy", "fallback"])("%s first-use recording", (backend) => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it.each([9009, 251, 0])(
      "does not record a shell exiting with %i during the grace window",
      async (exitCode) => {
        const { ctx, localSettings, mutate, write } = await localContext();
        const pty = await openProfile(ctx, profileForBackend(backend));
        shellStart.resolve(void 0);
        await vi.advanceTimersByTimeAsync(graceMs / 2);
        conhostExit.resolve(exitCode);
        await expect(pty?.onExit).resolves.toBe(exitCode);
        await vi.advanceTimersByTimeAsync(graceMs);
        expect(localSettings.value.hasUsedIntegratedTerminal).toBe(false);
        expect(mutate).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        localSettings.unload();
      },
    );

    it.each(["before", "after"])(
      "does not record a cancellation requested %s ConHost spawn",
      async (when) => {
        const { ctx, localSettings, mutate, write } = await localContext();
        const pty = await openProfile(ctx, profileForBackend(backend));
        if (when === "after") {
          shellStart.resolve(void 0);
          await vi.advanceTimersByTimeAsync(graceMs / 2);
        }
        const killed = pty?.kill();
        shellStart.resolve(void 0);
        await killed;
        await expect(pty?.shell).resolves.toBeUndefined();
        await expect(pty?.onExit).resolves.toBe(0);
        await vi.advanceTimersByTimeAsync(graceMs);
        expect(localSettings.value.hasUsedIntegratedTerminal).toBe(false);
        expect(mutate).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        localSettings.unload();
      },
    );
  });

  it.each(["failed", "setup-faulted", "cancelled"])(
    "does not record a %s integrated open",
    async (failure) => {
      const { ctx, localSettings, mutate, write } = await localContext();
      const pty = await openProfile(ctx, integratedProfile());
      if (failure !== "cancelled")
        shellStart.reject(
          failure === "setup-faulted"
            ? new ConPtyControlError("protocol")
            : new Error("shell start failed"),
        );
      await pty?.kill();
      expect(localSettings.value.hasUsedIntegratedTerminal).toBe(false);
      expect(mutate).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      localSettings.unload();
    },
  );

  it("does not record developer consoles, external terminals or Python checks", async () => {
    const { ctx, localSettings, mutate, write } = await localContext();
    const consolePty = new RefPsuedoterminal(new TextPseudoterminal());
    Object.assign(ctx, {
      developerConsolePTY: { onLoaded: Promise.resolve(() => consolePty) },
    });
    await (
      await openProfile(ctx, Settings.Profile.DEFAULTS.developerConsole)
    )?.kill();
    await consolePty.kill();
    await openProfile(ctx, Settings.Profile.DEFAULTS.external);
    expect(spawnExternalTerminalEmulator).toHaveBeenCalledTimes(1);
    Object.assign(ctx.settings, {
      value: { ...ctx.settings.value, profiles: {} },
    });
    await runPluginPythonCheck(
      ctx,
      vi.fn().mockResolvedValue({
        code: 0,
        stderr: "",
        stdout: "C:\\Python312\\python.exe\n3.12.0\n",
      }),
      vi.fn().mockResolvedValue(null),
    );
    expect(localSettings.value.hasUsedIntegratedTerminal).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    localSettings.unload();
  });

  it("keeps a successful terminal usable when local persistence fails", async () => {
    const { ctx, localSettings, write } = await localContext();
    const error = new Error("local storage unavailable"),
      debug = vi.spyOn(self.console, "debug").mockImplementation(() => {});
    write.mockRejectedValue(error);
    const pty = await openProfile(ctx, integratedProfile());
    shellStart.resolve(void 0);
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(error);
    });
    expect(pty).not.toBeNull();
    expect(localSettings.value.hasUsedIntegratedTerminal).toBe(true);
    await pty?.kill();
    localSettings.unload();
  });

  it("warns about a POSIX profile path on explicit open even when fallback succeeds", async () => {
    const profile = integratedProfile({ pythonExecutable: "/opt/python3" }),
      ctx = context("python");
    await (await openProfile(ctx, profile))?.kill();
    expect(checkWindowsPythonMock).toHaveBeenCalledWith(ctx, "/opt/python3");
    expect(spawn.mock.calls[0]?.[0].pythonExecutable).toBe(
      "C:\\Python312\\python.exe",
    );
    expect(notice2Spy.mock.calls.map(([message]) => message())).toEqual([
      "notices.win32-python-posix-path",
    ]);
    expect(profile.pythonExecutable).toBe("/opt/python3");
  });

  it("does not describe a slash-based UNC profile path as drive-relative", async () => {
    const profile = integratedProfile({
      pythonExecutable: "//server/share/python.exe",
    });
    await (await openProfile(context(), profile))?.kill();
    expect(notice2Spy).not.toHaveBeenCalled();
  });

  it("passes a live breaker predicate keyed by the effective Python", async () => {
    const ctx = context();
    await openProfile(ctx, integratedProfile());
    const predicate = spawn.mock.calls[0]?.[0].conPtyRuntimeUnavailable;
    const effective = checkWindowsPythonMock.mock.calls[0]?.[1];
    expect(effective).toBeDefined();
    expect(predicate?.()).toBe(false);
    invalidateConPtyRuntime(
      effective ?? "",
      ctx.settings.value.pythonExecutable,
    );
    expect(predicate?.()).toBe(true);
  });

  it("preserves an explicit saved legacy choice when Python is healthy", async () => {
    const pty = await openProfile(context(), savedProfile("legacy"));
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

  it("reuses failed discovery for two ConHost opens and recovers after expiry", async () => {
    vi.useFakeTimers();
    // Keep the production resolver/cache and inject only process results.
    const { checkWindowsPython: checkPython } = await vi.importActual<
        typeof import("../../../src/terminal/win32-doctor.js")
      >("../../../src/terminal/win32-doctor.js"),
      ctx = context("plugin-python"),
      profile = integratedProfile({ pythonExecutable: "profile-python" }),
      probe = vi.fn<Win32PythonSpawn>().mockResolvedValue({
        code: null,
        errno: "ENOENT",
        stderr: "",
        stdout: "",
      });
    checkWindowsPythonMock.mockImplementation((context0, value) =>
      checkPython(context0, value, probe, {
        locate: vi.fn().mockResolvedValue(null),
      }),
    );
    await (await openProfile(ctx, profile))?.kill();
    expect(probe.mock.calls.map(([executable]) => executable)).toEqual([
      "profile-python",
      "plugin-python",
      "python",
      "python3",
      "py",
    ]);
    probe.mockClear().mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "C:\\Python312\\python.exe\n3.12.0\n",
    });
    await (await openProfile(ctx, profile))?.kill();
    expect(probe).not.toHaveBeenCalled();
    expect(spawn.mock.calls.map(([args]) => args.win32Backend)).toEqual([
      "legacy",
      "legacy",
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    await (await openProfile(ctx, profile))?.kill();
    expect(probe).toHaveBeenCalled();
    expect(spawn.mock.calls.map(([args]) => args.win32Backend)).toEqual([
      "legacy",
      "legacy",
      "conpty",
    ]);
  });

  it.each<Settings.Profile.Win32Backend>(["conpty", "legacy"])(
    "preserves the %s notice budget until Python definitively fails",
    async (win32Backend) => {
      vi.useFakeTimers();
      // Exercise the real resolver and transient cache with injected process results.
      const { checkWindowsPython: checkPython } = await vi.importActual<
          typeof import("../../../src/terminal/win32-doctor.js")
        >("../../../src/terminal/win32-doctor.js"),
        ctx = context(),
        profile = integratedProfile({ pythonExecutable: "", win32Backend }),
        probe = vi.fn<Win32PythonSpawn>().mockResolvedValue({
          code: null,
          errno: "EACCES",
          stderr: "",
          stdout: "",
        }),
        i18n = createInstance();
      await i18n.init({ lng: "en", resources: { en: { translation: en } } });
      Object.assign(ctx.language, { value: i18n });
      checkWindowsPythonMock.mockImplementation((context0, value) =>
        checkPython(context0, value, probe, {
          locate: vi.fn().mockResolvedValue(null),
        }),
      );

      await (await openProfile(ctx, profile))?.kill();
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          win32Backend: "legacy",
          pythonExecutable: undefined,
        }),
      );
      expect(notice2Spy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_001);
      probe.mockResolvedValue({
        code: null,
        errno: "ENOENT",
        stderr: "",
        stdout: "",
      });
      await (await openProfile(ctx, profile))?.kill();
      await (await openProfile(ctx, profile))?.kill();
      expect(probe).toHaveBeenCalledTimes(6);
      expect(notice2Spy).toHaveBeenCalledTimes(1);
      const message = notice2Spy.mock.calls[0]?.[0]();
      expect(message).toBe(
        win32Backend === "conpty"
          ? `${i18n.t("notices.win32-conhost-fallback")}\n\n${i18n.t(
              "errors.win32-python-missing",
              { tried: "python, python3, py -3" },
            )}`
          : i18n.t("notices.win32-resizer-python-missing", {
              executable: "python",
            }),
      );
    },
  );

  it("opens a shared profile after changing its failed plugin fallback without prewarming its override", async () => {
    // Use the real resolver with a fake Python process to exercise the
    // configured pair through the opener, cache, breaker and prewarm.
    const { checkWindowsPython: checkPython } = await vi.importActual<
        typeof import("../../../src/terminal/win32-doctor.js")
      >("../../../src/terminal/win32-doctor.js"),
      first = "C:\\First\\python.exe",
      second = "C:\\Second\\python.exe",
      settings = settingsOf(first),
      ctx = context(first, settings),
      profile = PROFILE_PRESETS.pwshIntegrated,
      probe = vi.fn(async (executable: string) =>
        executable === first || executable === second
          ? { code: 0, stderr: "", stdout: `${executable}\n3.12.0\n` }
          : { code: null, errno: "ENOENT", stderr: "", stdout: "" },
      ),
      spare = vi
        .spyOn(CONPTY_HOST_POOL, "ensureSpare")
        .mockImplementation(vi.fn());
    checkWindowsPythonMock.mockImplementation((_ctx, value) =>
      checkPython(ctx, value, probe, {
        locate: vi.fn().mockResolvedValue(null),
      }),
    );
    await (await openProfile(ctx, profile))?.kill();
    reportConPtyRuntimeFailure("python3", first);
    await (await openProfile(ctx, profile))?.kill();
    await prewarmConPtyProfile(ctx, profile, { platform: "win32" });
    expect(spare).not.toHaveBeenCalled();
    settings.value.pythonExecutable = second;
    await (await openProfile(ctx, profile))?.kill();
    await prewarmConPtyProfile(ctx, profile, { platform: "win32" });
    expect(
      spawn.mock.calls.map(([args]) => [
        args.win32Backend,
        args.pythonExecutable,
      ]),
    ).toEqual([
      ["conpty", first],
      ["legacy", first],
      ["conpty", second],
    ]);
    expect(spare).not.toHaveBeenCalled();
    expect(profile.pythonExecutable).toBe("python3");
  });

  it.each<{
    readonly status: Win32PythonDiagnosis["status"];
    readonly version: string;
    readonly guidance: string;
  }>([
    { status: "missing", version: "", guidance: "No usable Python found" },
    {
      status: "store-stub",
      version: "",
      guidance: "opens the Microsoft Store instead of Python",
    },
    {
      status: "too-old",
      version: "3.8.10",
      guidance: "is Python 3.8.10, older than 3.9",
    },
  ])(
    "explains a $status Python when opening ConHost once per session",
    async ({ status, version, guidance }) => {
      const executable = "C:\\Python & Tools\\python.exe",
        tried = [
          executable,
          "D:\\Plugin\\python.exe",
          "python",
          "python3",
          "py -3",
        ],
        failed = diagnosis({
          executable,
          hostExecutable: null,
          status,
          tried,
          version,
        }),
        profile = integratedProfile({
          executable: "cmd.exe",
          pythonExecutable: "",
          win32Backend: "conpty",
        }),
        ctx = context(),
        i18n = createInstance();
      await i18n.init({ lng: "en", resources: { en: { translation: en } } });
      Object.assign(ctx.language, { value: i18n });
      checkWindowsPythonMock.mockResolvedValue(failed);

      // Startup prewarm must leave the open path's notice budget available.
      await prewarmConPtyProfile(ctx, profile, { platform: "win32" });
      expect(checkWindowsPythonMock).toHaveBeenCalledExactlyOnceWith(ctx, "");
      expect(notice2Spy).not.toHaveBeenCalled();
      await (await openProfile(ctx, profile))?.kill();
      await (await openProfile(ctx, profile))?.kill();

      expect(
        spawn.mock.calls.map(([args]) => [
          args.win32Backend,
          args.pythonExecutable,
        ]),
      ).toEqual([
        ["legacy", undefined],
        ["legacy", undefined],
      ]);
      expect(checkWindowsResizerPackagesMock).not.toHaveBeenCalled();
      expect(notice2Spy).toHaveBeenCalledTimes(1);
      const message = notice2Spy.mock.calls[0]?.[0]();
      expect(message).toContain(i18n.t("notices.win32-conhost-fallback"));
      expect(message).toContain(guidance);
      expect(message).toContain(executable);
      if (status === "missing") {
        expect(message).toContain(tried.join(", "));
      } else {
        expect(message).not.toContain("No usable Python found");
      }
      expect(message).not.toContain("was not found");
      expect(message).toContain("\n\n");
      expect(message).not.toContain("{{");
    },
  );

  it.each(["missing", "unconfirmed", "breaker"])(
    "uses ConHost without changing saved ConPTY intent when the host is %s",
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
      const profile = savedProfile();
      const pty = await openProfile(context(), profile);
      await pty?.kill();
      await (await openProfile(context(), profile))?.kill();
      expect(spawn.mock.calls.map(([args]) => args.win32Backend)).toEqual([
        "legacy",
        "legacy",
      ]);
      expect(profile).toHaveProperty("win32Backend", "conpty");
      expect(notice2Spy.mock.calls.map(([message]) => message())).toEqual(
        failure === "unconfirmed"
          ? []
          : [
              failure === "missing"
                ? "notices.win32-conhost-fallback\n\nerrors.win32-python-missing"
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
    noticeWin32ConhostFallback(context(), {
      reason: "missing-python",
      diagnosis: diagnosis({ status: "missing" }),
    });
    noticeWin32ConhostFallback(context(), {
      reason: "missing-python",
      diagnosis: diagnosis({ status: "missing" }),
    });
    expect(notice2Spy).toHaveBeenCalledTimes(1);
    expect(notice2Spy.mock.calls[0]?.[0]()).toBe(
      "notices.win32-conhost-fallback\n\nerrors.win32-python-missing",
    );
  });

  it("explains it again after the session guard is reset", () => {
    noticeWin32ConhostFallback(context(), {
      reason: "missing-python",
      diagnosis: diagnosis({ status: "missing" }),
    });
    resetWin32FallbackNotice();
    noticeWin32ConhostFallback(context(), {
      reason: "missing-python",
      diagnosis: diagnosis({ status: "missing" }),
    });
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
    noticeWin32ConhostFallback(context(), { reason: "runtime-failure" });
    expect(notice2Spy.mock.calls[0]?.[0]()).toBe(
      "notices.win32-conpty-runtime-fallback",
    );
  });

  it("does not suggest Python is missing or too old after a host failure", async () => {
    const ctx = context(),
      i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    Object.assign(ctx.language, { value: i18n });
    noticeWin32ConhostFallback(ctx, { reason: "runtime-failure" });
    const message = notice2Spy.mock.calls[0]?.[0]();
    expect(message).toContain("The ConPTY host failed to start");
    expect(message).not.toContain("needs Python");
    expect(message).not.toContain("not found");
    expect(message).not.toContain("reinstall");
  });

  it("shares one explanation budget across both causes", () => {
    noticeWin32ConhostFallback(context(), { reason: "runtime-failure" });
    noticeWin32ConhostFallback(context(), {
      reason: "missing-python",
      diagnosis: diagnosis({ status: "missing" }),
    });
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

  it("ignores local setup failures without a host exit", () => {
    expect(
      conPtyFailureCondemnsRuntime(
        new ConPtySetupError(new Error("disk full")),
        null,
      ),
    ).toBe(false);
  });

  it("ignores a user abort", () => {
    expect(
      conPtyFailureCondemnsRuntime(new ConPtyControlError("aborted"), 1),
    ).toBe(false);
  });

  it("condemns the runtime for any other pre-ready death", () => {
    for (const exit of [null, 1, 250]) {
      expect(conPtyFailureCondemnsRuntime(new Error("host failed"), exit)).toBe(
        true,
      );
    }
    for (const error of [
      new ConPtyControlError("protocol"),
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
    await prewarmConPtyProfile(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
    expect(checkWindowsPythonMock).not.toHaveBeenCalled();
  });

  it("does not recreate an invalidated spare after a pending diagnosis", async () => {
    const pending = Promise.withResolvers<Win32PythonDiagnosis>(),
      createControl = vi
        .spyOn(CONPTY_DEPENDENCIES, "createDeferredControl")
        .mockRejectedValue(new Error("Test stops before host boot")),
      ctx = context(),
      profile = integratedProfile({ pythonExecutable: "" });
    checkWindowsPythonMock.mockReturnValueOnce(pending.promise);
    try {
      const prewarming = prewarmConPtyProfile(ctx, profile, {
        platform: "win32",
      });
      expect(checkWindowsPythonMock).toHaveBeenCalledTimes(1);
      CONPTY_HOST_POOL.clear();
      pending.resolve(diagnosis());
      await prewarming;
      expect(createControl).not.toHaveBeenCalled();
      // A later request can still warm the current configuration.
      checkWindowsPythonMock.mockResolvedValueOnce(diagnosis());
      await prewarmConPtyProfile(ctx, profile, { platform: "win32" });
      expect(createControl).toHaveBeenCalledTimes(1);
    } finally {
      CONPTY_HOST_POOL.clear();
      createControl.mockRestore();
    }
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
      const pending = prewarm(
        ctx,
        integratedProfile({ pythonExecutable: "" }),
        { platform: "win32" },
      );
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
    await prewarmOnWindows(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
    expect(ensureSpare).toHaveBeenCalledTimes(1);
    expect(ensureSpare?.mock.calls[0]?.[0]).toBe("C:\\Python312\\python.exe");
  });

  it("boots the spare on the base interpreter behind a venv, as the open path spawns it", async () => {
    const venv = diagnosis({
      executable: "C:\\venv\\Scripts\\python.exe",
      hostExecutable: "C:\\Python312\\python.exe",
    });
    checkWindowsPythonMock.mockResolvedValue(venv);
    await prewarmOnWindows(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
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
    await prewarmOnWindows(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
    expect(ensureSpare).not.toHaveBeenCalled();
    expect(notice2Spy).not.toHaveBeenCalled();
  });

  it.each(["missing", "store-stub", "too-old"] as const)(
    "boots no spare when the Python check reports %s",
    async (status) => {
      checkWindowsPythonMock.mockResolvedValue(
        diagnosis({ executable: "python", status }),
      );
      await prewarmOnWindows(
        context(),
        integratedProfile({ pythonExecutable: "" }),
      );
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
    await prewarmOnWindows(
      context("", settings),
      integratedProfile({ pythonExecutable: "" }),
    );
    expect(checkWindowsPythonMock).toHaveBeenCalledTimes(1);
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it("boots no spare when the breaker trips during the Python check", async () => {
    checkWindowsPythonMock.mockImplementation(async () => {
      reportConPtyRuntimeFailure("");
      return diagnosis();
    });
    await prewarmOnWindows(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
    expect(ensureSpare).not.toHaveBeenCalled();
  });

  it("still prewarms an interpreter when another configuration failed", async () => {
    reportConPtyRuntimeFailure("broken-python");
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
    expect(ensureSpare).toHaveBeenCalledTimes(1);
  });

  it("does not notify during prewarm", async () => {
    checkWindowsPythonMock.mockResolvedValue(diagnosis());
    await prewarmOnWindows(
      context(),
      integratedProfile({ pythonExecutable: "" }),
    );
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

  it.each(["python", "C:\\Profile\\python.exe", "/opt/python3"])(
    "skips prewarming the profile override %s",
    async (pythonExecutable) => {
      checkWindowsPythonMock.mockResolvedValue(diagnosis());
      await prewarmOnWindows(
        context("D:\\Tools\\python.exe"),
        integratedProfile({ pythonExecutable }),
      );
      expect(checkWindowsPythonMock).not.toHaveBeenCalled();
      expect(ensureSpare).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/opt/python3",
    "\\tools\\python.exe",
    "\\\\server\\share\\python.exe",
    "bin/python",
    "C:python.exe",
  ])(
    "skips prewarming an excluded inherited value %s",
    async (pythonExecutable) => {
      checkWindowsPythonMock.mockResolvedValue(diagnosis());
      await prewarmOnWindows(
        context(pythonExecutable),
        integratedProfile({ pythonExecutable: "" }),
      );
      expect(checkWindowsPythonMock).not.toHaveBeenCalled();
      expect(ensureSpare).not.toHaveBeenCalled();
    },
  );
});
