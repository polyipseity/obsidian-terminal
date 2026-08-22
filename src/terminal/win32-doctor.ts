/**
 * Windows Python check and exit-code diagnostics. Resolves a usable Python
 * before each Windows PTY construction; results are cached per configured
 * value for the session.
 */
import {
  type AnyObject,
  SI_PREFIX_SCALE,
  cloneAsWritable,
  dynamicRequire,
  launderUnchecked,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import { cloneDeep } from "es-toolkit/compat";
import type { DeepWritable } from "ts-essentials";
import { BUNDLE } from "../imports.js";
import { CHECK_EXECUTABLE_WAIT, PYTHON_REQUIREMENTS } from "../magic.js";
import type { TerminalPlugin } from "../main.js";
import { Settings } from "../settings-data.js";
import { applyEnv } from "./environment.js";

const childProcess = dynamicRequire<typeof import("node:child_process")>(
    BUNDLE,
    "node:child_process",
  ),
  util = dynamicRequire<typeof import("node:util")>(BUNDLE, "node:util"),
  execFileP = (async () => {
    const [childProcess2, util2] = await Promise.all([childProcess, util]);
    return util2.promisify(childProcess2.execFile);
  })();

/** Official Python download page, opened by the settings download button. */
export const PYTHON_DOWNLOADS_URL = "https://www.python.org/downloads/";

/** Exit code `cmd.exe` reports when a command name cannot be resolved. */
export const WIN32_EXIT_COMMAND_NOT_FOUND = 9009,
  /** ConPTY host exit code: the shell exists but Windows refused to start
   * it (access denied, not an executable, missing working directory). */
  WIN32_EXIT_SHELL_START_FAILED = 251,
  /** `STATUS_DLL_INIT_FAILED` (0xC0000142): the console client failed to
   * initialize. Seen when ConPTY cannot attach the child. */
  WIN32_EXIT_DLL_INIT_FAILED = 3_221_225_794,
  /** Signed 32-bit representation Node may report for 0xC0000142. */
  WIN32_EXIT_DLL_INIT_FAILED_SIGNED = -1_073_741_502,
  /** Minimum supported Python, from the requirements manifest. */
  WIN32_MINIMUM_PYTHON: readonly [number, number] = [
    PYTHON_REQUIREMENTS.Python.version.major,
    PYTHON_REQUIREMENTS.Python.version.minor,
  ];

const WIN32_PYTHON_IDENTITY_SOURCE =
  'import sys; print(sys.executable); print("%d.%d.%d" % tuple(sys.version_info[:3]))';

export type Win32ExitCodeKey =
  | "errors.win32-exit-251"
  | "errors.win32-exit-9009"
  | "errors.win32-exit-c0000142";

/**
 * Maps a Windows exit code to an actionable message key. Returns `null` for
 * every other code, which keeps the generic exit notice.
 */
export function win32ExitCodeKey(
  code: NodeJS.Signals | number,
): Win32ExitCodeKey | null {
  if (code === WIN32_EXIT_COMMAND_NOT_FOUND) {
    return "errors.win32-exit-9009";
  }
  if (code === WIN32_EXIT_SHELL_START_FAILED) {
    return "errors.win32-exit-251";
  }
  if (
    code === WIN32_EXIT_DLL_INIT_FAILED ||
    code === WIN32_EXIT_DLL_INIT_FAILED_SIGNED
  ) {
    return "errors.win32-exit-c0000142";
  }
  return null;
}

export interface Win32PythonProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Process exit code, or `null` when the process could not be started. */
  readonly code: number | null;
  /** True when the probe was killed by its own timeout. */
  readonly timedOut?: boolean;
}

export type Win32PythonSpawn = (
  executable: string,
  args: readonly string[],
) => Promise<Win32PythonProcessResult>;

export interface Win32PythonCandidate {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface Win32PythonIdentity {
  /** Absolute interpreter path reported by `sys.executable`. */
  readonly executable: string;
  readonly version: string;
}

export type Win32PythonStatus = "missing" | "ok" | "store-stub" | "too-old";

export interface Win32PythonDiagnosis {
  readonly status: Win32PythonStatus;
  /** Verified interpreter the PTY spawns when usable; failed candidate
   * otherwise. */
  readonly executable: string;
  /** Version reported by the identity probe, empty when unavailable. */
  readonly version: string;
  /** Short, non-localized diagnostic detail for logs. */
  readonly detail: string;
  /** True when a probe timed out or threw; callers must persist nothing on
   * it. */
  readonly transient?: boolean;
}

/**
 * Resolution order: the profile's executable first, then the launcher, then
 * the two usual names.
 */
export function win32PythonCandidates(
  pythonExecutable: string,
): readonly Win32PythonCandidate[] {
  const ret: Win32PythonCandidate[] = [];
  if (pythonExecutable) {
    ret.push({ args: [], executable: pythonExecutable });
  }
  ret.push(
    { args: ["-3"], executable: "py" },
    { args: [], executable: "python" },
    { args: [], executable: "python3" },
  );
  return ret;
}

/** Parses `Python 3.11.4` from `--version` output. Python <3.4 prints it on
 * stderr, so callers should pass both streams joined. */
export function parsePythonVersion(output: string): string {
  const match = /Python\s+(\d+\.\d+(?:\.\d+)?)/u.exec(output);
  return match?.[1] ?? "";
}

/** Parses the interpreter identity printed by the Python check probe. */
export function parseWindowsPythonIdentity(
  output: string,
): Win32PythonIdentity | null {
  const [executable0 = "", version0 = ""] = output
      .replaceAll("\r", "")
      .split("\n"),
    executable = executable0.trim(),
    version = version0.trim();
  if (!executable || !/^\d+\.\d+(?:\.\d+)?$/u.test(version)) {
    return null;
  }
  return { executable, version };
}

/** Compares a dotted version against a minimum. Unparseable input is old. */
export function isPythonVersionSupported(
  version: string,
  minimum: readonly [number, number] = WIN32_MINIMUM_PYTHON,
): boolean {
  const [major = NaN, minor = NaN] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    return false;
  }
  const [minMajor, minMinor] = minimum;
  if (major !== minMajor) {
    return major > minMajor;
  }
  return minor >= minMinor;
}

/**
 * Detects the Microsoft Store `python.exe` stub, which either fails with 9009
 * or opens the Store and prints nothing. An installed Store Python answers the
 * probe through the same `WindowsApps` alias path, so that path condemns a
 * candidate only when the probe reported no interpreter identity.
 */
export function isStoreStub(
  executable: string,
  result: Win32PythonProcessResult,
): boolean {
  if (result.code === WIN32_EXIT_COMMAND_NOT_FOUND) {
    return true;
  }
  if (result.code === 0 && !`${result.stdout}${result.stderr}`.trim()) {
    return true;
  }
  return (
    /[\\/]WindowsApps[\\/]/iu.test(executable) &&
    !parseWindowsPythonIdentity(result.stdout)
  );
}

/**
 * Classifies one candidate from its canonical identity probe. A usable
 * candidate reports the probed string itself, because that is the string the
 * PTY spawns. The canonical `sys.executable` path stays in `detail` for logs.
 */
export function classifyPythonResult(
  executable: string,
  result: Win32PythonProcessResult,
): Win32PythonDiagnosis {
  if (result.timedOut ?? false) {
    return {
      detail: "identity probe timed out",
      executable,
      status: "missing",
      transient: true,
      version: "",
    };
  }
  if (isStoreStub(executable, result)) {
    return {
      detail: `store stub (code ${String(result.code)})`,
      executable,
      status: "store-stub",
      version: "",
    };
  }
  const identity = parseWindowsPythonIdentity(result.stdout),
    version =
      identity?.version ??
      parsePythonVersion(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    return {
      detail: `identity probe failed (code ${String(result.code)})`,
      executable,
      status: "missing",
      version,
    };
  }
  if (!version) {
    return {
      detail: `no version in output (code ${String(result.code)})`,
      executable,
      status: "missing",
      version: "",
    };
  }
  if (!isPythonVersionSupported(version)) {
    return {
      detail: `found ${version}`,
      executable,
      status: "too-old",
      version,
    };
  }
  if (!identity) {
    return {
      detail: "identity probe did not report sys.executable",
      executable,
      status: "missing",
      version,
    };
  }
  return {
    detail: `found ${version} at ${identity.executable}`,
    executable,
    status: "ok",
    version,
  };
}

/**
 * Probes the canonical interpreter behind a launcher candidate. The launcher
 * takes arguments the PTY cannot carry, so its `sys.executable` path must
 * answer a probe of its own before it becomes the spawn target. Returns `null`
 * when the canonical path does not run.
 */
async function confirmCanonicalPython(
  spawn: Win32PythonSpawn,
  canonicalExecutable: string,
): Promise<Win32PythonDiagnosis | null> {
  let result: Win32PythonProcessResult;
  try {
    result = await spawn(canonicalExecutable, [
      "-c",
      WIN32_PYTHON_IDENTITY_SOURCE,
    ]);
  } catch (error) {
    /* @__PURE__ */ self.console.debug(error);
    return null;
  }
  const diagnosis = classifyPythonResult(canonicalExecutable, result);
  return diagnosis.status === "ok" ? diagnosis : null;
}

/** Probes the configured executable, then `py -3`, `python`, `python3`. */
export async function diagnoseWindowsPython(
  spawn: Win32PythonSpawn,
  pythonExecutable: string,
): Promise<Win32PythonDiagnosis> {
  return diagnoseWindowsPythonCandidates(
    spawn,
    win32PythonCandidates(pythonExecutable),
  );
}

/** Probes one value without the fallback chain. */
export async function resolveWindowsPythonValue(
  spawn: Win32PythonSpawn,
  pythonExecutable: string,
): Promise<Win32PythonDiagnosis> {
  return diagnoseWindowsPythonCandidates(spawn, [
    { args: [], executable: pythonExecutable },
  ]);
}

async function diagnoseWindowsPythonCandidates(
  spawn: Win32PythonSpawn,
  candidates: readonly Win32PythonCandidate[],
): Promise<Win32PythonDiagnosis> {
  let firstFailure: Win32PythonDiagnosis | null = null,
    sawTransient = false;
  for (const { args, executable } of candidates) {
    let result: Win32PythonProcessResult;
    try {
      result = await spawn(executable, [
        ...args,
        "-c",
        WIN32_PYTHON_IDENTITY_SOURCE,
      ]);
    } catch (error) {
      /* @__PURE__ */ self.console.debug(error);
      // A thrown probe has no exit code to reason from: transient.
      sawTransient = true;
      firstFailure ??= {
        detail: String(error),
        executable,
        status: "missing",
        transient: true,
        version: "",
      };
      continue;
    }
    const diagnosis = classifyPythonResult(executable, result);
    sawTransient ||= diagnosis.transient ?? false;
    if (diagnosis.status === "ok") {
      // Shims and launchers run the interpreter as a child; the PTY must
      // spawn the interpreter itself (PID identity), so a confirmed
      // `sys.executable` becomes the spawn target. A launcher whose canonical
      // path does not run is disqualified.
      const identity = parseWindowsPythonIdentity(result.stdout),
        canonicalExecutable = identity?.executable ?? "";
      if (
        canonicalExecutable &&
        !sameExecutable(canonicalExecutable, executable)
      ) {
        const confirmed = await confirmCanonicalPython(
          spawn,
          canonicalExecutable,
        );
        if (confirmed) {
          return confirmed;
        }
      }
      if (args.length === 0) {
        return diagnosis;
      }
      // A launcher's arguments cannot travel to the PTY spawn, so an
      // unconfirmed canonical path disqualifies the candidate.
      firstFailure ??= {
        detail: `canonical path unconfirmed (${canonicalExecutable})`,
        executable,
        status: "missing",
        version: diagnosis.version,
      };
      continue;
    }
    firstFailure ??= diagnosis;
  }
  const failure = firstFailure ?? {
    detail: "no candidate",
    executable: "",
    status: "missing" as const,
    version: "",
  };
  // One timed-out candidate makes the whole result transient.
  return sawTransient && !(failure.transient ?? false)
    ? { ...failure, transient: true }
    : failure;
}

/** The profile's own Python executable when set, the plugin-level one
 * otherwise. */
export function inheritedPythonExecutable(
  profileValue: string,
  pluginValue: string,
): string {
  return profileValue || pluginValue;
}

const DEFAULT_SPAWN: Win32PythonSpawn = async (executable, args) => {
  const execFileP2 = await execFileP;
  try {
    const { stdout, stderr } = await execFileP2(executable, [...args], {
      env: await applyEnv(),
      timeout: CHECK_EXECUTABLE_WAIT * SI_PREFIX_SCALE,
      windowsHide: true,
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    // `execFile` rejections carry the exit code (or an errno string such as
    // `ENOENT`) plus the captured streams as own properties. A rejection
    // whose child was `killed` is this call's own timeout firing.
    const { code, killed, stderr, stdout } = launderUnchecked<AnyObject>(error);
    return {
      code: typeof code === "number" ? code : null,
      stderr: typeof stderr === "string" ? stderr : "",
      stdout: typeof stdout === "string" ? stdout : "",
      timedOut: killed === true,
    };
  }
};

const diagnoses = new Map<string, Promise<Win32PythonDiagnosis>>(),
  notified = new Set<string>();

/** Clears the session cache. Tests only. */
export function clearWindowsPythonDiagnoses(): void {
  diagnoses.clear();
  notified.clear();
  resizerPackages.clear();
}

const resizerPackages = new Set<string>(),
  // The manifest's package entries; "Python" names the interpreter itself.
  WIN32_RESIZER_IMPORT_SOURCE = `import ${Object.keys(PYTHON_REQUIREMENTS)
    .filter((name) => name !== "Python")
    .join(", ")}`;

/**
 * One paste-ready command installing the ConHost resizer's packages with the
 * interpreter the profile runs. The specs are quoted because `>` redirects in
 * both PowerShell and cmd; a path with whitespace uses the PowerShell
 * call-operator form.
 */
export function win32ResizerInstallCommand(pythonExecutable: string): string {
  const requirements = Object.entries(PYTHON_REQUIREMENTS)
    .filter(([name]) => name !== "Python")
    .map(
      ([name, { maximum, version }]) =>
        `"${name}>=${version.version}${maximum ? `,<=${maximum.version}` : ""}"`,
    )
    .join(" ");
  return /\s/u.test(pythonExecutable)
    ? `& "${pythonExecutable}" -m pip install --upgrade ${requirements}`
    : `${pythonExecutable} -m pip install --upgrade ${requirements}`;
}

/**
 * Probes the packages the ConHost resizer imports, with the same plain
 * spawn the resizer uses (no isolation flags — site-packages must load).
 * Success is cached for the session; a failure re-probes, so a mid-session
 * `pip install` is picked up on the next open.
 */
export async function checkWindowsResizerPackages(
  pythonExecutable: string,
  spawn: Win32PythonSpawn = DEFAULT_SPAWN,
): Promise<boolean> {
  if (resizerPackages.has(pythonExecutable)) {
    return true;
  }
  let ok = false;
  try {
    const result = await spawn(pythonExecutable, [
      "-c",
      WIN32_RESIZER_IMPORT_SOURCE,
    ]);
    ok = result.code === 0;
  } catch (error) {
    /* @__PURE__ */ self.console.debug(error);
  }
  if (ok) {
    resizerPackages.add(pythonExecutable);
  }
  return ok;
}

/**
 * Evicts one cached diagnosis and re-arms its notice. For callers that
 * discover at runtime that a checked interpreter cannot host a session; the
 * next check re-probes and may notify again.
 */
export function invalidateWindowsPythonDiagnosis(
  pythonExecutable: string,
): void {
  diagnoses.delete(pythonExecutable);
  notified.delete(pythonExecutable);
}

/**
 * Runs the Python check once per session per configured executable and shows
 * one notice when it fails. Callers await it before constructing a Windows
 * PTY so the same interpreter is used by every helper in that request.
 */
export async function checkWindowsPython(
  context: TerminalPlugin,
  pythonExecutable: string,
  spawn: Win32PythonSpawn = DEFAULT_SPAWN,
  options: { readonly notify?: boolean } = {},
): Promise<Win32PythonDiagnosis> {
  const { notify = true } = options,
    cached = diagnoses.get(pythonExecutable);
  if (cached) {
    return cached;
  }
  const diagnosis = diagnoseWindowsPython(spawn, pythonExecutable);
  // Retained while in flight so concurrent first callers share one probe.
  diagnoses.set(pythonExecutable, diagnosis);
  let ret: Win32PythonDiagnosis;
  try {
    ret = await diagnosis;
  } catch (error) {
    diagnoses.delete(pythonExecutable);
    throw error;
  }
  const { detail, executable, status, version } = ret;
  if (status === "ok") {
    notified.delete(pythonExecutable);
    return ret;
  }
  // Failures are not cached: the notice asks the user to install Python and
  // the next open must re-probe. A missing interpreter fails fast, so this
  // is cheap.
  diagnoses.delete(pythonExecutable);
  const {
    language: { value: i18n },
    settings,
  } = context;
  self.console.warn(`Python check: ${status} (${detail})`);
  if (notify && !notified.has(pythonExecutable)) {
    notified.add(pythonExecutable);
    notice2(
      () =>
        i18n.t(`errors.win32-python-${status}`, {
          executable,
          interpolation: { escapeValue: false },
          version,
        }),
      settings.value.errorNoticeTimeout,
      context,
    );
  }
  return ret;
}

/**
 * Aligns every Windows-capable integrated profile's stored backend with a
 * plugin-level Python check result. Returns `true` when any profile changed.
 *
 * - No usable Python: ConPTY profiles are demoted to ConHost and marked
 *   auto-demoted.
 * - Usable Python: only auto-demoted profiles are re-promoted to ConPTY; a
 *   stale marker on a ConPTY profile is cleared.
 *
 * Only Python-check results reach this; the circuit breaker does not.
 */
export function applyWin32BackendVerdict(
  profiles: DeepWritable<Settings.Profiles>,
  pythonUsable: boolean,
): boolean {
  let changed = false;
  for (const profile of Object.values(profiles)) {
    if (!isWin32Integrated(profile)) {
      continue;
    }
    if (!pythonUsable) {
      if (profile.win32Backend === "conpty") {
        profile.win32Backend = "legacy";
        profile.win32BackendAutoDemoted = true;
        changed = true;
      }
      continue;
    }
    if (profile.win32BackendAutoDemoted) {
      profile.win32Backend = "conpty";
      profile.win32BackendAutoDemoted = false;
      changed = true;
    }
  }
  return changed;
}

const pluginDiagnoses = new WeakMap<TerminalPlugin, Win32PythonDiagnosis>(),
  pluginDiagnosisListeners = new WeakMap<TerminalPlugin, Set<() => void>>();

/** Windows paths compare case-insensitively. */
function sameExecutable(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isWin32Integrated<T extends Settings.Profile>(
  profile: T,
): profile is T & { readonly type: "integrated" } {
  return (
    profile.type === "integrated" &&
    Settings.Profile.isCompatible(profile, "win32")
  );
}

/**
 * Notifies whenever {@link runPluginPythonCheck} publishes a result, so an
 * open settings tab can replace its "checking" status without a reopen.
 * Returns the unregister function.
 */
export function onPluginPythonDiagnosis(
  context: TerminalPlugin,
  listener: () => void,
): () => void {
  let listeners = pluginDiagnosisListeners.get(context);
  if (!listeners) {
    listeners = new Set();
    pluginDiagnosisListeners.set(context, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Latest plugin-level result this session, or `null` before the first
 * {@link runPluginPythonCheck} settles. Drives the settings tab's status. */
export function getPluginPythonDiagnosis(
  context: TerminalPlugin,
): Win32PythonDiagnosis | null {
  return pluginDiagnoses.get(context) ?? null;
}

/**
 * Runs the plugin-level Python check and aligns stored settings with its
 * result. The plugin-level `pythonExecutable`:
 *
 * - Empty: adopts the verified spawn string and marks it discovered.
 * - Discovered earlier and decisively dead: replaced by the new discovery,
 *   or cleared when nothing runs any more.
 * - User-typed: not changed.
 */
export async function runPluginPythonCheck(
  context: TerminalPlugin,
  spawn: Win32PythonSpawn = DEFAULT_SPAWN,
): Promise<Win32PythonDiagnosis> {
  const { settings } = context,
    { pythonExecutable: configured, pythonExecutableDiscovered } =
      settings.value;
  // Always re-probe: the recheck button must see a Python installed moments
  // ago.
  invalidateWindowsPythonDiagnosis(configured);
  const diagnosis = await checkWindowsPython(context, configured, spawn, {
    notify: false,
  });
  pluginDiagnoses.set(context, diagnosis);
  const usable = diagnosis.status === "ok",
    transient = diagnosis.transient ?? false;
  let adopted: string | null = null;
  if (!configured) {
    if (usable) adopted = diagnosis.executable;
  } else if (
    pythonExecutableDiscovered &&
    (!usable || !sameExecutable(diagnosis.executable, configured))
  ) {
    // The chain passed over the discovered value; only its own decisive
    // failure lets the field move.
    const own = usable
      ? await resolveWindowsPythonValue(spawn, configured)
      : diagnosis;
    if (own.status !== "ok" && !(own.transient ?? false)) {
      adopted = usable ? diagnosis.executable : "";
    }
  }
  const profileValues = new Set<string>();
  for (const profile of Object.values(settings.value.profiles)) {
    if (isWin32Integrated(profile) && profile.pythonExecutable) {
      profileValues.add(profile.pythonExecutable);
    }
  }
  const profileResolutions = new Map<string, string>();
  await Promise.all(
    [...profileValues].map(async (value) => {
      const resolved = await resolveWindowsPythonValue(spawn, value);
      if (resolved.status !== "ok") return;
      // The opener keys its check by the stored value and probes a cache
      // miss again; a usable value is exactly what the chain would find.
      diagnoses.set(value, Promise.resolve(resolved));
      if (!sameExecutable(resolved.executable, value)) {
        profileResolutions.set(value, resolved.executable);
        diagnoses.set(resolved.executable, Promise.resolve(resolved));
      }
    }),
  );
  if (adopted) {
    diagnoses.set(adopted, Promise.resolve(diagnosis));
  }
  // Transient results move nothing.
  const applyVerdict = usable || !transient,
    // `mutate` clones and re-publishes the whole settings tree, so a
    // load that changes nothing must not call it. Rehearse the result on
    // a copy first.
    changed =
      adopted !== null ||
      profileResolutions.size > 0 ||
      (applyVerdict &&
        applyWin32BackendVerdict(
          cloneAsWritable(settings.value.profiles, cloneDeep),
          usable,
        ));
  if (changed) {
    await settings.mutate((settingsM) => {
      if (adopted !== null) {
        settingsM.pythonExecutable = adopted;
        settingsM.pythonExecutableDiscovered = adopted !== "";
      }
      for (const profile of Object.values(settingsM.profiles)) {
        if (!isWin32Integrated(profile)) {
          continue;
        }
        const resolved = profileResolutions.get(profile.pythonExecutable);
        if (resolved !== void 0) {
          profile.pythonExecutable = resolved;
        }
      }
      if (applyVerdict) {
        applyWin32BackendVerdict(settingsM.profiles, usable);
      }
    });
    await settings.write();
  }
  for (const listener of pluginDiagnosisListeners.get(context) ?? []) {
    try {
      listener();
    } catch (error) {
      self.console.warn(error);
    }
  }
  return diagnosis;
}
