import {
  Platform,
  deepFreeze,
  deopaque,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import type { AsyncOrSync } from "ts-essentials";
import type { TerminalPlugin } from "../main.js";
import { Settings } from "../settings-data.js";
import {
  SUPPORTS_EXTERNAL_TERMINAL_EMULATOR,
  spawnExternalTerminalEmulator,
} from "./emulator.js";
import {
  CONPTY_DEPENDENCIES,
  CONPTY_HOST_POOL,
  ConPtyControlError,
  Pseudoterminal,
  RefPsuedoterminal,
  TextPseudoterminal,
  registerConPtyPoolDisposal,
} from "./pseudoterminal.js";
import {
  WIN32_EXIT_COMMAND_NOT_FOUND,
  WIN32_EXIT_SHELL_START_FAILED,
  checkWindowsPython,
  checkWindowsResizerPackages,
  inheritedPythonExecutable,
  invalidateWindowsPythonDiagnosis,
  win32ResizerInstallCommand,
} from "./win32-doctor.js";

export interface OpenOptions {
  /** Fitted terminal size, passed to the pseudoterminal at spawn. */
  readonly columns?: number | undefined;
  readonly cwd?: string | undefined;
  readonly rows?: number | undefined;
}

/** Picks the backend one spawn runs on; ConPTY needs a usable Python. */
export function resolveWin32Backend(
  configured: Settings.Profile.Win32Backend,
  pythonUsable: boolean,
): Settings.Profile.Win32Backend {
  return configured === "conpty" && !pythonUsable ? "legacy" : configured;
}

/**
 * Decides whether one failed ConPTY session condemns the runtime for the
 * rest of the session. Aborts and shell-start failures (9009/251) do not:
 * ConHost would fail the same way.
 */
export function conPtyFailureCondemnsRuntime(
  error: unknown,
  hostExit: Awaited<Pseudoterminal["onExit"]> | null,
): boolean {
  if (error instanceof ConPtyControlError && error.reason === "aborted") {
    return false;
  }
  return (
    hostExit !== WIN32_EXIT_COMMAND_NOT_FOUND &&
    hostExit !== WIN32_EXIT_SHELL_START_FAILED
  );
}

let win32ResizerDisabledNotified = false,
  win32ConhostFallbackNotified = false,
  conptyRuntimeUnavailable = false;

/** Clears the once-per-session notice guards and the breaker. Tests only. */
export function resetWin32FallbackNotice(): void {
  win32ConhostFallbackNotified = false;
  win32ResizerDisabledNotified = false;
  conptyRuntimeUnavailable = false;
}

export interface Win32ResizerDisabledCause {
  readonly reason: "packages-missing" | "python-missing";
  /** The interpreter that lacks the packages, or the one that was tried. */
  readonly pythonExecutable: string;
}

/** Explains, once per session, that ConHost opened without automatic resizing. */
export function noticeWin32ResizerDisabled(
  context: TerminalPlugin,
  cause: Win32ResizerDisabledCause,
): void {
  if (win32ResizerDisabledNotified) return;
  win32ResizerDisabledNotified = true;
  const {
    language: { value: i18n },
    settings,
  } = context;
  notice2(
    () =>
      cause.reason === "packages-missing"
        ? i18n.t("notices.win32-resizer-packages-missing", {
            command: win32ResizerInstallCommand(cause.pythonExecutable),
            interpolation: { escapeValue: false },
          })
        : i18n.t("notices.win32-resizer-python-missing", {
            executable: cause.pythonExecutable,
            interpolation: { escapeValue: false },
          }),
    settings.value.errorNoticeTimeout,
    context,
  );
}

/** True after a ConPTY host failed between spawn and ready this session.
 * Tests only. */
export function isConPtyRuntimeUnavailable(): boolean {
  return conptyRuntimeUnavailable;
}

/**
 * Records a ConPTY host that spawned but never reached ready. Later spawns
 * fall back to ConHost, and the cached Python check for this interpreter is
 * evicted so the next check re-probes.
 */
export function reportConPtyRuntimeFailure(pythonExecutable: string): void {
  conptyRuntimeUnavailable = true;
  invalidateWindowsPythonDiagnosis(pythonExecutable);
  // A spare booted before the failure is part of the same broken runtime.
  CONPTY_HOST_POOL.clear();
}

/** Explains the degraded backend once per session. */
export function noticeWin32ConhostFallback(
  context: TerminalPlugin,
  cause: "missing-python" | "runtime-failure",
): void {
  if (win32ConhostFallbackNotified) return;
  win32ConhostFallbackNotified = true;
  const {
    language: { value: i18n },
    settings,
  } = context;
  notice2(
    () =>
      i18n.t(
        cause === "runtime-failure"
          ? "notices.win32-conpty-runtime-fallback"
          : "notices.win32-conhost-fallback",
      ),
    settings.value.errorNoticeTimeout,
    context,
  );
}

export const PROFILE_PROPERTIES: {
  readonly [key in Settings.Profile.Type]: {
    readonly available: boolean;
    readonly valid: boolean;
    readonly integratable: boolean;
    readonly opener: (
      context: TerminalPlugin,
      profile: Settings.Profile.Typed<key>,
      options?: OpenOptions,
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
      options?: OpenOptions,
    ) {
      await spawnExternalTerminalEmulator(profile.executable, profile.args, {
        cwd: options?.cwd,
        environment: profile.environment,
      });
      return null;
    },
    valid: true,
  },
  integrated: {
    available: Pseudoterminal.PLATFORM_PSEUDOTERMINAL !== null,
    integratable: true,
    async opener(
      context: TerminalPlugin,
      profile: Settings.Profile.Typed<"integrated">,
      options?: OpenOptions,
    ) {
      if (!Pseudoterminal.PLATFORM_PSEUDOTERMINAL) {
        return null;
      }
      const { args, environment, executable, pythonExecutable, win32Backend } =
        profile;
      if (!Settings.Profile.isCompatible(profile, Platform.CURRENT)) {
        return null;
      }
      const effectivePythonExecutable =
          deopaque(Platform.CURRENT) === "win32"
            ? inheritedPythonExecutable(
                pythonExecutable,
                context.settings.value.pythonExecutable,
              )
            : pythonExecutable,
        diagnosis =
          deopaque(Platform.CURRENT) === "win32"
            ? await checkWindowsPython(
                context,
                effectivePythonExecutable,
                void 0,
                // The backend-specific notices below explain a failure.
                { notify: false },
              )
            : null,
        pythonUsable = diagnosis?.status === "ok",
        backend = diagnosis
          ? resolveWin32Backend(
              win32Backend,
              pythonUsable && !conptyRuntimeUnavailable,
            )
          : win32Backend,
        fallback = backend !== win32Backend,
        requestPythonExecutable = diagnosis
          ? pythonUsable
            ? diagnosis.executable
            : // The resizer must not be handed a rejected interpreter; the
              // Python check already notified.
              void 0
          : pythonExecutable || void 0;
      if (diagnosis && fallback) {
        self.console.warn(
          `ConPTY unavailable, opening on ConHost: ${diagnosis.status} (${diagnosis.detail})`,
        );
        noticeWin32ConhostFallback(
          context,
          pythonUsable ? "runtime-failure" : "missing-python",
        );
      }
      let spawnPythonExecutable = requestPythonExecutable;
      if (diagnosis && backend === "legacy") {
        // ConHost runs without a resizer; a rejected Python or missing
        // packages opens resizer-less with one notice. A runtime fallback
        // already explained the missing Python.
        if (spawnPythonExecutable === void 0) {
          if (!fallback) {
            noticeWin32ResizerDisabled(context, {
              pythonExecutable: diagnosis.executable,
              reason: "python-missing",
            });
          }
        } else if (
          !(await checkWindowsResizerPackages(spawnPythonExecutable))
        ) {
          noticeWin32ResizerDisabled(context, {
            pythonExecutable: spawnPythonExecutable,
            reason: "packages-missing",
          });
          spawnPythonExecutable = void 0;
        }
      }
      const pty = new Pseudoterminal.PLATFORM_PSEUDOTERMINAL(context, {
        args,
        columns: options?.columns,
        cwd: options?.cwd,
        environment,
        executable,
        pythonExecutable: spawnPythonExecutable,
        rows: options?.rows,
        win32Backend: backend,
      });
      if (backend === "conpty") {
        // A host that dies before ready trips the breaker so the next open
        // falls back; this pane already shows the host's own error notice.
        pty.shell.catch(async (error: unknown) => {
          const exit = await pty.onExit.then(
            (code) => code,
            () => null,
          );
          if (!conPtyFailureCondemnsRuntime(error, exit)) return;
          /* @__PURE__ */ self.console.debug(error);
          // The resolved value is the Python check's cache key, so the
          // eviction must use it too — the profile field may be empty.
          reportConPtyRuntimeFailure(effectivePythonExecutable);
        });
      }
      return new RefPsuedoterminal<Pseudoterminal>(pty);
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
  options?: OpenOptions,
): AsyncOrSync<RefPsuedoterminal<Pseudoterminal> | null> {
  const type0: T = profile.type;
  return PROFILE_PROPERTIES[type0].opener(context, profile, options);
}

/**
 * Boots one spare ConPTY host for a profile that opts into the conpty
 * backend. Silent: a broken interpreter notifies on the open path, not here.
 */
export async function prewarmConPtyProfile(
  context: TerminalPlugin,
  profile: Settings.Profile,
  options: { readonly platform?: Platform.All } = {},
): Promise<void> {
  const { platform = Platform.CURRENT } = options;
  if (
    profile.type !== "integrated" ||
    platform !== "win32" ||
    profile.win32Backend !== "conpty" ||
    !Settings.Profile.isCompatible(profile, platform)
  )
    return;
  // Both can change while the Python check runs: opting out clears the pool,
  // and a breaker trip condemns the runtime, so a spare booted afterwards
  // would be unwanted or doomed. Checked again before the boot.
  const wanted = (): boolean =>
    context.settings.value.prewarmConPty && !conptyRuntimeUnavailable;
  if (!wanted()) return;
  // Resolves the same way as the open path so the pool key matches.
  const effectivePythonExecutable = inheritedPythonExecutable(
    profile.pythonExecutable,
    context.settings.value.pythonExecutable,
  );
  const diagnosis = await checkWindowsPython(
    context,
    effectivePythonExecutable,
    void 0,
    { notify: false },
  );
  if (diagnosis.status !== "ok" || !wanted()) return;
  registerConPtyPoolDisposal(context, CONPTY_HOST_POOL);
  CONPTY_HOST_POOL.ensureSpare(diagnosis.executable, CONPTY_DEPENDENCIES);
}
