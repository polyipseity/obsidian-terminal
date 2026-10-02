/**
 * Windows Python check and exit-code diagnostics. Resolves a usable Python
 * before each Windows PTY construction; results are cached per configured
 * value and plugin fallback: successes for the session, failures briefly.
 */
import {
  type AnyObject,
  SI_PREFIX_SCALE,
  dynamicRequire,
  launderUnchecked,
} from "@polyipseity/obsidian-plugin-library";
import { BUNDLE } from "../imports.js";
import {
  CHECK_EXECUTABLE_WAIT,
  PYTHON_REQUIREMENTS,
  WIN32_EXIT_COMMAND_NOT_FOUND,
  WIN32_EXIT_SHELL_START_FAILED,
} from "../magic.js";
import type { TerminalPlugin } from "../main.js";
import { Settings } from "../settings-data.js";
import {
  applyEnv,
  getSystemPathGeneration,
  invalidateSystemPath,
  pathEnvKey,
} from "./environment.js";
import type { Pseudoterminal } from "./pseudoterminal.js";

const childProcess = dynamicRequire<typeof import("node:child_process")>(
    BUNDLE,
    "node:child_process",
  ),
  fsPromises = dynamicRequire<typeof import("node:fs/promises")>(
    BUNDLE,
    "node:fs/promises",
  ),
  util = dynamicRequire<typeof import("node:util")>(BUNDLE, "node:util"),
  execFileP = (async () => {
    const [childProcess2, util2] = await Promise.all([childProcess, util]);
    return util2.promisify(childProcess2.execFile);
  })();

/** Official Python download page, opened by the settings download button. */
export const PYTHON_DOWNLOADS_URL = "https://www.python.org/downloads/";

export { WIN32_EXIT_COMMAND_NOT_FOUND, WIN32_EXIT_SHELL_START_FAILED };

/** `STATUS_DLL_INIT_FAILED` (0xC0000142): a process failed to initialize.
 * Classified only when the ConPTY host exits before ready; a shell exiting
 * with this code after ready gets the generic exit notice. */
export const WIN32_EXIT_DLL_INIT_FAILED = 3_221_225_794,
  /** Signed 32-bit representation Node may report for 0xC0000142. */
  WIN32_EXIT_DLL_INIT_FAILED_SIGNED = -1_073_741_502,
  /** Minimum supported Python, from the requirements manifest. */
  WIN32_MINIMUM_PYTHON: readonly [number, number] = [
    PYTHON_REQUIREMENTS.Python.version.major,
    PYTHON_REQUIREMENTS.Python.version.minor,
  ];

/** A command name without a directory or drive, which Windows resolves by
 * search. */
const BARE_NAME = /^[^\\/:]+$/u,
  /** Drive-absolute (`C:\`) or UNC (`\\server\`) directory. */
  ABSOLUTE_DIRECTORY = /^(?:[A-Za-z]:|[\\/])[\\/]/u,
  /** A `WindowsApps` path segment; Microsoft Store aliases and packages live
   * under such a directory. */
  WINDOWS_APPS_SEGMENT = /[\\/]WindowsApps[\\/]/iu;

/** Empty keeps discovery; automatic Windows checks accept names and drive-absolute paths. */
export function isAutomaticWindowsPythonExecutable(
  executable: string,
): boolean {
  return (
    !executable ||
    BARE_NAME.test(executable) ||
    /^[A-Za-z]:[\\/]/u.test(executable)
  );
}

const WIN32_PYTHON_IDENTITY_SOURCE =
  'import sys; print(sys.executable); print("%d.%d.%d" % tuple(sys.version_info[:3])); print(getattr(sys, "_base_executable", "") or sys.executable)';

export type Win32ExitCodeKey =
  | "errors.win32-exit-251"
  | "errors.win32-exit-9009"
  | "errors.win32-exit-c0000142";

/**
 * Maps a Windows exit code to an actionable message key. Returns `null` for
 * every other code, which keeps the generic exit notice.
 * The view consults this only for a ConPTY start that failed before ready
 * without its own notice.
 */
export function win32ExitCodeKey(
  code: Awaited<Pseudoterminal["onExit"]>,
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
  /** Process exit code, or `null` when the process reported none. */
  readonly code: number | null;
  /** Errno string (`ENOENT`, `EPERM`, …) of a process that never started. */
  readonly errno?: string;
  /** True when the probe was killed by its own timeout. */
  readonly timedOut?: boolean;
}

export type Win32PythonSpawn = (
  executable: string,
  args: readonly string[],
) => Promise<Win32PythonProcessResult>;

/**
 * Resolves a bare command name to an absolute path through `PATH`, never the
 * working directory. Resolves `null` when no entry holds the name.
 */
export type Win32PathLocator = (name: string) => Promise<string | null>;

export interface Win32PythonCandidate {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface Win32PythonIdentity {
  /** Absolute interpreter path reported by `sys.executable`. */
  readonly executable: string;
  readonly version: string;
  /** Interpreter behind a venv redirector, from `sys._base_executable`;
   * `executable` when the probe reported none. */
  readonly baseExecutable: string;
}

export type Win32PythonStatus = "missing" | "ok" | "store-stub" | "too-old";

export interface Win32PythonDiagnosis {
  readonly status: Win32PythonStatus;
  /** Verified interpreter the ConHost resizer and `pip install` run when
   * usable; failed candidate otherwise. */
  readonly executable: string;
  /** Interpreter the ConPTY host is spawned with. A venv's `python.exe`
   * redirects to its base interpreter in a child process, so the base path
   * stands here once it answered a probe of its own; `executable`
   * otherwise. `null` when the base probe proved nothing: the interpreter
   * is usable, but no ConPTY host is confirmed this time. */
  readonly hostExecutable: string | null;
  /** The configured value or chain entry (`python`, `py -3`) this result
   * answers for, as typed or named — the status row shows it next to the
   * interpreter it runs. */
  readonly candidate: string;
  /** Discovery candidates attempted in order, including launcher arguments;
   * excludes canonical/base-interpreter confirmation probes. */
  readonly tried: readonly string[];
  /** Version reported by the identity probe, empty when unavailable. */
  readonly version: string;
  /** Short, non-localized diagnostic detail for logs. */
  readonly detail: string;
  /** True when a probe timed out, threw, or never ran. Failures receive a
   * short retry delay; successful transient results stay provisional. */
  readonly transient?: boolean;
  /** Spawn errno when the probe did not run. */
  readonly errno?: string;
}

/**
 * Resolution order: the profile executable, the plugin fallback, the two
 * usual names, then the launcher. `python` precedes `python3` because the
 * python.org installer ships only `python.exe`.
 */
export function win32PythonCandidates(
  pythonExecutable: string,
  fallbackPythonExecutable = "",
): readonly Win32PythonCandidate[] {
  const ret: Win32PythonCandidate[] = [];
  if (pythonExecutable) {
    ret.push({ args: [], executable: pythonExecutable });
  }
  if (
    fallbackPythonExecutable &&
    fallbackPythonExecutable !== pythonExecutable
  ) {
    ret.push({ args: [], executable: fallbackPythonExecutable });
  }
  for (const entry of [
    { args: [], executable: "python" },
    { args: [], executable: "python3" },
    { args: ["-3"], executable: "py" },
  ]) {
    if (
      !ret.some(
        ({ args, executable }) =>
          sameExecutable(executable, entry.executable) &&
          args.length === entry.args.length &&
          args.every((arg, index) => arg === entry.args[index]),
      )
    ) {
      ret.push(entry);
    }
  }
  return ret;
}

/**
 * Absolute paths a `PATH` value can hold for a bare command name, in search
 * order. As libuv does, a name with an extension is tried as written first,
 * and every name is tried with `.com` then `.exe` appended. Relative entries
 * are skipped: they resolve against the working directory, which is the
 * search this replaces.
 */
export function win32PathCandidates(
  name: string,
  pathValue: string,
): readonly string[] {
  const names = [
    ...(name.includes(".") ? [name] : []),
    `${name}.com`,
    `${name}.exe`,
  ];
  return pathValue
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((entry) => ABSOLUTE_DIRECTORY.test(entry))
    .flatMap((entry) =>
      names.map((name2) => `${entry.replace(/[\\/]+$/u, "")}\\${name2}`),
    );
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
  // An answer without the third line predates the base-interpreter probe.
  const [executable0 = "", version0 = "", baseExecutable0 = ""] = output
      .replaceAll("\r", "")
      .split("\n"),
    executable = executable0.trim(),
    version = version0.trim();
  if (!executable || !/^\d+\.\d+(?:\.\d+)?$/u.test(version)) {
    return null;
  }
  return {
    baseExecutable: baseExecutable0.trim() || executable,
    executable,
    version,
  };
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
    WINDOWS_APPS_SEGMENT.test(executable) &&
    !parseWindowsPythonIdentity(result.stdout)
  );
}

/** A diagnosis of `executable` as probed: it hosts ConPTY itself until
 * `resolveHostExecutable` names another interpreter. */
function pythonDiagnosis(
  executable: string,
  candidate: string,
  status: Win32PythonStatus,
  detail: string,
  version = "",
  transient = false,
): Win32PythonDiagnosis {
  return {
    candidate,
    detail,
    executable,
    hostExecutable: executable,
    status,
    ...(transient ? { transient } : {}),
    tried: candidate ? [candidate] : [],
    version,
  };
}

/**
 * Classifies one candidate from its identity probe alone. A usable candidate
 * reports the probed string itself; the caller replaces it with the canonical
 * `sys.executable` path, kept in `detail` for logs, once that path answers a
 * probe of its own.
 */
export function classifyPythonResult(
  executable: string,
  result: Win32PythonProcessResult,
  candidate = executable,
): Win32PythonDiagnosis {
  if (result.timedOut ?? false) {
    return pythonDiagnosis(
      executable,
      candidate,
      "missing",
      "identity probe timed out",
      "",
      true,
    );
  }
  if (result.code === null && result.errno !== "ENOENT") {
    // Only a file that does not exist is decisive. A locked or denied
    // executable (antivirus, `EPERM`, `EBUSY`) says nothing about whether
    // Python is installed, and neither does a probe without an exit code.
    return {
      ...pythonDiagnosis(
        executable,
        candidate,
        "missing",
        `identity probe did not run (${result.errno ?? "no exit code"})`,
        "",
        true,
      ),
      ...(result.errno ? { errno: result.errno } : {}),
    };
  }
  if (isStoreStub(executable, result)) {
    return pythonDiagnosis(
      executable,
      candidate,
      "store-stub",
      `store stub (code ${String(result.code)})`,
    );
  }
  const identity = parseWindowsPythonIdentity(result.stdout),
    version =
      identity?.version ??
      parsePythonVersion(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    return pythonDiagnosis(
      executable,
      candidate,
      "missing",
      `identity probe failed (${result.errno ?? `code ${String(result.code)}`})`,
      version,
    );
  }
  if (!version) {
    return pythonDiagnosis(
      executable,
      candidate,
      "missing",
      `no version in output (code ${String(result.code)})`,
    );
  }
  if (!isPythonVersionSupported(version)) {
    return pythonDiagnosis(
      executable,
      candidate,
      "too-old",
      `found ${version}`,
      version,
    );
  }
  if (!identity) {
    return pythonDiagnosis(
      executable,
      candidate,
      "missing",
      "identity probe did not report sys.executable",
      version,
    );
  }
  return pythonDiagnosis(
    executable,
    candidate,
    "ok",
    `found ${version} at ${identity.executable}`,
    version,
  );
}

/**
 * Runs the identity probe on one candidate. A thrown probe has no exit code
 * to reason from: transient.
 */
async function probePython(
  spawn: Win32PythonSpawn,
  executable: string,
  args: readonly string[],
  candidate: string,
): Promise<readonly [Win32PythonDiagnosis, Win32PythonIdentity | null]> {
  let result: Win32PythonProcessResult;
  try {
    result = await spawn(executable, [
      ...args,
      "-c",
      WIN32_PYTHON_IDENTITY_SOURCE,
    ]);
  } catch (error) {
    /* @__PURE__ */ self.console.debug(error);
    return [
      pythonDiagnosis(
        executable,
        candidate,
        "missing",
        String(error),
        "",
        true,
      ),
      null,
    ];
  }
  return [
    classifyPythonResult(executable, result, candidate),
    parseWindowsPythonIdentity(result.stdout),
  ];
}

/**
 * Names the interpreter the ConPTY host spawns. A venv's `python.exe` runs
 * its base interpreter as a child process, which breaks the host's PID
 * identity, so the reported base path takes over once it answers a probe of
 * its own. `executable` stays the venv, which holds the packages. A base path
 * already `rejected` by its own probe is not probed again. A base probe that
 * proved nothing confirms no host: spawning the venv's launcher would fail
 * the PID check and condemn the runtime. The venv itself stays usable, so the
 * ConHost resizer keeps it, and the transient result stays provisional.
 */
async function resolveHostExecutable(
  spawn: Win32PythonSpawn,
  diagnosis: Win32PythonDiagnosis,
  identity: Win32PythonIdentity | null,
  rejected = "",
): Promise<Win32PythonDiagnosis> {
  const baseExecutable = identity?.baseExecutable ?? "";
  if (
    !baseExecutable ||
    sameExecutable(baseExecutable, diagnosis.executable) ||
    sameExecutable(baseExecutable, rejected)
  ) {
    return diagnosis;
  }
  const [base] = await probePython(
    spawn,
    baseExecutable,
    [],
    diagnosis.candidate,
  );
  if (base.status === "ok") {
    return { ...diagnosis, hostExecutable: baseExecutable };
  }
  return (base.transient ?? false)
    ? { ...diagnosis, hostExecutable: null, transient: true }
    : diagnosis;
}

/**
 * Resolves a bare name that must stay the spawn target to the absolute path
 * `PATH` holds for it, and confirms that path. libuv searches the child's
 * working directory — which can be a vault — before `PATH` for a bare name.
 * Returns `null` when the name is not bare, nothing resolves, or the resolved
 * path does not run — which the `rejected` path already showed of itself. A
 * confirmation that proved nothing is returned as the transient failure it is.
 */
async function locateBarePython(
  spawn: Win32PythonSpawn,
  locate: Win32PathLocator,
  name: string,
  candidate: string,
  rejected: string,
): Promise<Win32PythonDiagnosis | null> {
  if (!BARE_NAME.test(name)) {
    return null;
  }
  let located: string | null = null;
  try {
    located = await locate(name);
  } catch (error) {
    /* @__PURE__ */ self.console.debug(error);
  }
  if (located === null || sameExecutable(located, rejected)) {
    return null;
  }
  const [confirmed, identity] = await probePython(
    spawn,
    located,
    [],
    candidate,
  );
  if (confirmed.status === "ok") {
    return resolveHostExecutable(spawn, confirmed, identity, rejected);
  }
  return (confirmed.transient ?? false) ? confirmed : null;
}

/**
 * Settles a candidate that answered its probe on the interpreter to spawn.
 * Shims and launchers run the interpreter as a child; the PTY must spawn the
 * interpreter itself (PID identity), so a confirmed `sys.executable` becomes
 * the spawn target. The absolute path also keeps the spawn independent of the
 * terminal's directory, which libuv searches before PATH for a bare name. A
 * confirmation that proved nothing approves nothing: the transient failure is
 * returned, so the caller neither persists nor caches an unverified target.
 */
async function settlePythonCandidate(
  spawn: Win32PythonSpawn,
  locate: Win32PathLocator,
  { args, executable }: Win32PythonCandidate,
  diagnosis: Win32PythonDiagnosis,
  identity: Win32PythonIdentity | null,
): Promise<Win32PythonDiagnosis> {
  const { candidate } = diagnosis,
    canonicalExecutable = identity?.executable ?? "";
  let unconfirmed = false;
  if (canonicalExecutable && !sameExecutable(canonicalExecutable, executable)) {
    // The path must answer a probe of its own before it is spawned.
    const [confirmed, confirmedIdentity] = await probePython(
      spawn,
      canonicalExecutable,
      [],
      candidate,
    );
    if (confirmed.status === "ok") {
      return resolveHostExecutable(spawn, confirmed, confirmedIdentity);
    }
    if (
      (confirmed.transient ?? false) &&
      !(
        WINDOWS_APPS_SEGMENT.test(canonicalExecutable) &&
        (confirmed.errno === "EACCES" || confirmed.errno === "EPERM")
      )
    ) {
      return confirmed;
    }
    unconfirmed = true;
  }
  if (args.length > 0) {
    // A launcher's arguments cannot travel to the PTY spawn, so an
    // unconfirmed canonical path disqualifies the candidate.
    return pythonDiagnosis(
      executable,
      candidate,
      "missing",
      `canonical path unconfirmed (${canonicalExecutable})`,
      diagnosis.version,
    );
  }
  if (!unconfirmed) {
    return resolveHostExecutable(spawn, diagnosis, identity);
  }
  // Microsoft Store Python: the canonical path under `WindowsApps` cannot be
  // executed directly while its alias can, so the probed string stays usable
  // — a bare name as the absolute path `PATH` holds for it, whenever there is
  // one.
  return (
    (await locateBarePython(
      spawn,
      locate,
      executable,
      candidate,
      canonicalExecutable,
    )) ?? diagnosis
  );
}

/** Probes the configured executables, then `python`, `python3`, `py -3`. */
export async function diagnoseWindowsPython(
  spawn: Win32PythonSpawn,
  pythonExecutable: string,
  locate: Win32PathLocator = DEFAULT_LOCATE,
  fallbackPythonExecutable = "",
): Promise<Win32PythonDiagnosis> {
  return diagnoseWindowsPythonCandidates(
    spawn,
    locate,
    win32PythonCandidates(pythonExecutable, fallbackPythonExecutable),
  );
}

async function diagnoseWindowsPythonCandidates(
  spawn: Win32PythonSpawn,
  locate: Win32PathLocator,
  candidates: readonly Win32PythonCandidate[],
): Promise<Win32PythonDiagnosis> {
  // Accumulate only discovery entries, before each candidate is probed.
  const tried: string[] = [];
  let firstFailure: Win32PythonDiagnosis | null = null,
    sawTransient = false;
  for (const entry of candidates) {
    const { args, executable } = entry,
      candidate = [executable, ...args].join(" ");
    tried.push(candidate);
    const [diagnosis, identity] = await probePython(
        spawn,
        executable,
        args,
        candidate,
      ),
      settled =
        diagnosis.status === "ok"
          ? await settlePythonCandidate(
              spawn,
              locate,
              entry,
              diagnosis,
              identity,
            )
          : diagnosis;
    if (settled.status === "ok") {
      return {
        ...settled,
        ...(sawTransient ? { transient: true } : {}),
        tried,
      };
    }
    sawTransient ||= settled.transient ?? false;
    firstFailure ??= settled;
  }
  const failure =
    firstFailure ?? pythonDiagnosis("", "", "missing", "no candidate");
  // One transient candidate makes the whole result transient.
  return { ...failure, ...(sawTransient ? { transient: true } : {}), tried };
}

/** The profile's own Python executable when set, the plugin-level one
 * otherwise. */
export function inheritedPythonExecutable(
  profileValue: string,
  pluginValue: string,
): string {
  return profileValue || pluginValue;
}

/** Resolution and runtime state depend on both configured candidates. */
export function win32PythonConfigurationKey(
  pythonExecutable: string,
  fallbackPythonExecutable = "",
): string {
  return JSON.stringify([
    pythonExecutable,
    fallbackPythonExecutable === pythonExecutable
      ? ""
      : fallbackPythonExecutable,
  ]);
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
      errno: typeof code === "string" ? code : void 0,
      stderr: typeof stderr === "string" ? stderr : "",
      stdout: typeof stdout === "string" ? stdout : "",
      timedOut: killed === true,
    };
  }
};

const DEFAULT_LOCATE: Win32PathLocator = async (name) => {
  const [{ lstat }, env] = await Promise.all([fsPromises, applyEnv()]),
    // The same environment the probes run in; Windows names it `Path`.
    pathValue = env[pathEnvKey(env)] ?? "";
  for (const file of win32PathCandidates(name, pathValue)) {
    try {
      // `stat` and `access` fail on an App Execution Alias reparse point,
      // which is exactly the Microsoft Store entry this looks for.
      await lstat(file);
      return file;
    } catch {
      // Not in this entry — try the next.
    }
  }
  return null;
};

interface NegativePythonDiagnosis {
  readonly diagnosis: Win32PythonDiagnosis;
  readonly expiresAt: number;
  readonly pathGeneration: number;
}

interface ProvisionalPythonDiagnosis {
  readonly diagnosis: Win32PythonDiagnosis;
  readonly pathGeneration: number;
  readonly revalidateAfter: number;
  readonly revalidating: boolean;
}

const NEGATIVE_DIAGNOSIS_TTL = 30_000,
  TRANSIENT_NEGATIVE_DIAGNOSIS_TTL = 5_000,
  PROVISIONAL_REVALIDATION_INTERVAL = 30_000;
// Advances when settings invalidate failures and provisional results.
let negativeDiagnosisGeneration = 0;

const diagnoses = new Map<string, Promise<Win32PythonDiagnosis>>(),
  negativeDiagnoses = new Map<string, NegativePythonDiagnosis>(),
  provisionalDiagnoses = new Map<string, ProvisionalPythonDiagnosis>(),
  displayDiagnoses = new Map<string, Win32PythonDiagnosis>(),
  displayOwners = new Map<string, symbol>(),
  windowsStateListeners = new Set<() => void>(),
  // Same configured-value keys as the Python cache. A new token identifies
  // each failure so a check already in flight cannot clear a later failure.
  conPtyRuntimeFailures = new Map<string, symbol>();

/** Blocks ConPTY for this Python configuration until a successful recheck. */
export function invalidateConPtyRuntime(
  pythonExecutable: string,
  fallbackPythonExecutable = "",
): void {
  conPtyRuntimeFailures.set(
    win32PythonConfigurationKey(pythonExecutable, fallbackPythonExecutable),
    Symbol(),
  );
  invalidateWindowsPythonDiagnosis(pythonExecutable, fallbackPythonExecutable);
  notifyListeners(windowsStateListeners);
}

export function isConPtyRuntimeUnavailable(
  pythonExecutable: string,
  fallbackPythonExecutable = "",
): boolean {
  return conPtyRuntimeFailures.has(
    win32PythonConfigurationKey(pythonExecutable, fallbackPythonExecutable),
  );
}

/** Clears the session cache. Tests only. */
export function clearWindowsPythonDiagnoses(): void {
  invalidateWindowsPythonNegativeDiagnoses();
  diagnoses.clear();
  displayDiagnoses.clear();
  displayOwners.clear();
  windowsStateListeners.clear();
  pluginDiagnoses = new WeakMap();
  pluginDiagnosisListeners = new WeakMap();
  pluginCheckGenerations = new WeakMap();
  pendingPluginChecks = new WeakMap();
  resizerPackages.clear();
  conPtyRuntimeFailures.clear();
}

/** Latest settled device result, including failures evicted from the execution cache. */
export function getWindowsPythonDiagnosis(
  pythonExecutable: string,
  fallbackPythonExecutable = "",
): Win32PythonDiagnosis | null {
  return (
    displayDiagnoses.get(
      win32PythonConfigurationKey(pythonExecutable, fallbackPythonExecutable),
    ) ?? null
  );
}

/** Subscribe to accepted probe results and ConPTY breaker changes. */
export function onWindowsPythonStateChange(listener: () => void): () => void {
  windowsStateListeners.add(listener);
  return () => windowsStateListeners.delete(listener);
}

function notifyListeners(listeners: Iterable<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      self.console.warn(error);
    }
  }
}

function publishWindowsDiagnosis(
  key: string,
  diagnosis: Win32PythonDiagnosis,
  owner: symbol,
): void {
  if (displayOwners.get(key) !== owner) return;
  displayDiagnoses.set(key, diagnosis);
  notifyListeners(windowsStateListeners);
}

function claimWindowsDiagnosis(key: string): symbol {
  const owner = Symbol();
  displayOwners.set(key, owner);
  return owner;
}

const resizerPackages = new Map<string, Promise<boolean>>(),
  // The manifest's package entries; "Python" names the interpreter itself.
  WIN32_RESIZER_IMPORT_SOURCE = `import ${Object.keys(PYTHON_REQUIREMENTS)
    .filter((name) => name !== "Python")
    .join(", ")}`;

/**
 * A PowerShell command installing the ConHost resizer's packages with the
 * interpreter the profile runs. Quote requirements to keep `>` literal and
 * special interpreter paths with a single-quoted string to prevent expansion.
 * PowerShell also treats smart apostrophes as single-quote delimiters.
 */
export function win32ResizerInstallCommand(pythonExecutable: string): string {
  const requirements = Object.entries(PYTHON_REQUIREMENTS)
    .filter(([name]) => name !== "Python")
    .map(([name, { version }]) => `"${name}>=${version.version}"`)
    .join(" ");
  return /[^A-Za-z0-9_.:\\/-]/u.test(pythonExecutable)
    ? `& '${pythonExecutable.replaceAll(/['\u2018-\u201b]/gu, "$&$&")}' -m pip install --upgrade ${requirements}`
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
  const cached = resizerPackages.get(pythonExecutable);
  if (cached) return cached;
  const probe = (async (): Promise<boolean> => {
    try {
      const result = await spawn(pythonExecutable, [
        "-c",
        WIN32_RESIZER_IMPORT_SOURCE,
      ]);
      return result.code === 0;
    } catch (error) {
      /* @__PURE__ */ self.console.debug(error);
      return false;
    }
  })().then((ok) => {
    if (!ok && resizerPackages.get(pythonExecutable) === probe) {
      resizerPackages.delete(pythonExecutable);
    }
    return ok;
  });
  resizerPackages.set(pythonExecutable, probe);
  return probe;
}

/**
 * Evicts one cached diagnosis. For callers that discover at runtime that a
 * checked interpreter cannot host a session; the next check re-probes silently.
 */
export function invalidateWindowsPythonDiagnosis(
  pythonExecutable: string,
  fallbackPythonExecutable = "",
): void {
  const key = win32PythonConfigurationKey(
    pythonExecutable,
    fallbackPythonExecutable,
  );
  diagnoses.delete(key);
  negativeDiagnoses.delete(key);
  provisionalDiagnoses.delete(key);
}

/** Drops failed and provisional results without probes, PATH refresh or prewarming. */
export function invalidateWindowsPythonNegativeDiagnoses(): void {
  negativeDiagnosisGeneration++;
  negativeDiagnoses.clear();
  provisionalDiagnoses.clear();
}

/**
 * Drops one cache entry only while it still holds `diagnosis`. A check the
 * cache moved on from — a recheck invalidated it and installed a newer probe
 * meanwhile — owns nothing to evict, and deleting the newer entry would make
 * the next open re-probe an interpreter that was just resolved.
 */
function evictOwnDiagnosis(
  key: string,
  diagnosis: Promise<Win32PythonDiagnosis>,
): void {
  if (diagnoses.get(key) === diagnosis) {
    diagnoses.delete(key);
  }
}

/**
 * Checks Python silently, caching stable successes and briefly reusing failures
 * per configuration and plugin fallback. Provisional successes return at once
 * while revalidating in the background. Callers await it before constructing a
 * Windows PTY; the open path explains any backend fallback or disabled resizer.
 */
export async function checkWindowsPython(
  context: TerminalPlugin,
  pythonExecutable: string,
  spawn: Win32PythonSpawn = DEFAULT_SPAWN,
  options: {
    readonly locate?: Win32PathLocator;
    readonly publish?: boolean;
  } = {},
): Promise<Win32PythonDiagnosis> {
  const { locate = DEFAULT_LOCATE, publish = true } = options,
    fallbackPythonExecutable = context.settings.value.pythonExecutable,
    key = win32PythonConfigurationKey(
      pythonExecutable,
      fallbackPythonExecutable,
    ),
    cached = diagnoses.get(key);
  if (cached) {
    if (publish && !displayDiagnoses.has(key)) {
      // A stale plugin check can leave a reusable execution result without
      // publishing it. A later opener/editor may claim it for display.
      const owner = claimWindowsDiagnosis(key);
      const settled = await cached;
      if (diagnoses.get(key) === cached || !diagnoses.has(key)) {
        publishWindowsDiagnosis(key, settled, owner);
      }
    }
    return cached;
  }
  const pathGeneration = getSystemPathGeneration(),
    negativeGeneration = negativeDiagnosisGeneration,
    provisional = provisionalDiagnoses.get(key),
    negative = negativeDiagnoses.get(key);
  let revalidation: ProvisionalPythonDiagnosis | null = null;
  if (provisional) {
    if (provisional.pathGeneration === pathGeneration) {
      if (
        provisional.revalidating ||
        Date.now() < provisional.revalidateAfter
      ) {
        if (publish && !displayDiagnoses.has(key)) {
          publishWindowsDiagnosis(
            key,
            provisional.diagnosis,
            claimWindowsDiagnosis(key),
          );
        }
        return provisional.diagnosis;
      }
      revalidation = {
        ...provisional,
        revalidateAfter: Date.now() + PROVISIONAL_REVALIDATION_INTERVAL,
        revalidating: true,
      };
      provisionalDiagnoses.set(key, revalidation);
    } else {
      provisionalDiagnoses.delete(key);
    }
  }
  if (negative) {
    if (
      negative.pathGeneration === pathGeneration &&
      Date.now() < negative.expiresAt
    ) {
      if (publish && !displayDiagnoses.has(key)) {
        publishWindowsDiagnosis(
          key,
          negative.diagnosis,
          claimWindowsDiagnosis(key),
        );
      }
      return negative.diagnosis;
    }
    negativeDiagnoses.delete(key);
  }
  const owner = publish ? claimWindowsDiagnosis(key) : null;
  const diagnosis = diagnoseWindowsPython(
    spawn,
    pythonExecutable,
    locate,
    fallbackPythonExecutable,
  );
  // Only foreground callers share an in-flight entry in the success cache.
  if (!revalidation) diagnoses.set(key, diagnosis);
  const currentGeneration = (): boolean =>
      pathGeneration === getSystemPathGeneration() &&
      negativeGeneration === negativeDiagnosisGeneration,
    ownsDiagnosis = (): boolean =>
      revalidation
        ? provisionalDiagnoses.get(key) === revalidation && currentGeneration()
        : diagnoses.get(key) === diagnosis,
    checked = diagnosis
      .then((ret) => {
        // Invalidation revokes background ownership, including display updates.
        const owned = ownsDiagnosis(),
          { detail, status } = ret;
        if (revalidation && !owned) return ret;
        if (status === "ok") {
          if (ret.transient ?? false) {
            if (owned && currentGeneration()) {
              provisionalDiagnoses.set(key, {
                diagnosis: ret,
                pathGeneration,
                revalidateAfter: revalidation?.revalidateAfter ?? 0,
                revalidating: false,
              });
            }
            evictOwnDiagnosis(key, diagnosis);
          } else if (revalidation && owned) {
            provisionalDiagnoses.delete(key);
            diagnoses.set(key, diagnosis);
          }
        } else {
          // Measure retry delay from settlement. Invalidated or superseded work
          // must neither install a failure nor evict a newer probe or success.
          if (owned && currentGeneration()) {
            provisionalDiagnoses.delete(key);
            negativeDiagnoses.set(key, {
              diagnosis: ret,
              expiresAt:
                Date.now() +
                (ret.transient
                  ? TRANSIENT_NEGATIVE_DIAGNOSIS_TTL
                  : NEGATIVE_DIAGNOSIS_TTL),
              pathGeneration,
            });
          }
          evictOwnDiagnosis(key, diagnosis);
          self.console.warn(`Python check: ${status} (${detail})`);
        }
        if (owner !== null && owned) {
          publishWindowsDiagnosis(key, ret, owner);
        } else if (
          revalidation &&
          displayDiagnoses.get(key) === revalidation.diagnosis
        ) {
          // Startup can revalidate without a display claim. Replace only the
          // provisional result it superseded, leaving newer displays alone.
          publishWindowsDiagnosis(key, ret, claimWindowsDiagnosis(key));
        }
        return ret;
      })
      .catch((error: unknown) => {
        if (revalidation && ownsDiagnosis()) {
          provisionalDiagnoses.set(key, {
            ...revalidation,
            revalidating: false,
          });
        }
        evictOwnDiagnosis(key, diagnosis);
        throw error;
      });
  if (revalidation) {
    void checked.catch((error: unknown) => {
      /* @__PURE__ */ self.console.debug(error);
    });
    if (owner !== null && !displayDiagnoses.has(key) && ownsDiagnosis()) {
      publishWindowsDiagnosis(key, revalidation.diagnosis, owner);
    }
    return revalidation.diagnosis;
  }
  return checked;
}

interface PendingPluginPythonCheck {
  readonly configured: string;
  readonly generation: number;
}

let pluginDiagnoses = new WeakMap<TerminalPlugin, Win32PythonDiagnosis>(),
  pluginDiagnosisListeners = new WeakMap<TerminalPlugin, Set<() => void>>(),
  pluginCheckGenerations = new WeakMap<TerminalPlugin, number>(),
  pendingPluginChecks = new WeakMap<TerminalPlugin, PendingPluginPythonCheck>();

/** Whether a plugin-level check is in flight for this configured value. */
export function isPluginPythonCheckPending(
  context: TerminalPlugin,
  configured: string,
): boolean {
  return pendingPluginChecks.get(context)?.configured === configured;
}

/** Windows paths compare case-insensitively. */
export function sameExecutable(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The opener's ConPTY predicate, with a display reason for the editor. */
export function windowsConPtyStatus(
  diagnosis: Win32PythonDiagnosis | null,
  pythonExecutable: string,
  fallbackPythonExecutable = "",
):
  | "checking"
  | "available"
  | "missing"
  | "unconfirmed"
  | "runtime-unavailable"
  | "unverified" {
  if (!diagnosis) return "checking";
  if (diagnosis.status !== "ok" && diagnosis.transient) return "unverified";
  if (diagnosis.status !== "ok") return "missing";
  if (diagnosis.hostExecutable === null) return "unconfirmed";
  return isConPtyRuntimeUnavailable(pythonExecutable, fallbackPythonExecutable)
    ? "runtime-unavailable"
    : "available";
}

/** An override's typed candidate can fail while discovery still succeeds. */
export function pythonOverrideStatus(
  override: string,
  diagnosis: Win32PythonDiagnosis | null,
):
  | "checking"
  | "using"
  | "fallback"
  | "missing"
  | "store-stub"
  | "too-old"
  | "unverified" {
  if (!diagnosis) return "checking";
  if (diagnosis.status !== "ok" && diagnosis.transient) return "unverified";
  if (diagnosis.status !== "ok") return diagnosis.status;
  return sameExecutable(override, diagnosis.candidate) ||
    sameExecutable(override, diagnosis.executable)
    ? "using"
    : "fallback";
}

/**
 * Settings-tab status key for a diagnosis. A discovered name maps to the
 * interpreter it runs (`ok-resolved`); a configured path is that interpreter
 * (`ok`). Failed probes carrying errno show the refusal detail before the
 * generic transient message.
 */
export function pythonStatusKey(
  diagnosis: Win32PythonDiagnosis | null,
  checking: boolean,
):
  | "checking"
  | "ok-resolved"
  | "unverified"
  | "unverified-errno"
  | Win32PythonStatus {
  if (checking || !diagnosis) return "checking";
  if (diagnosis.status !== "ok" && diagnosis.errno) return "unverified-errno";
  if (diagnosis.status !== "ok" && diagnosis.transient) return "unverified";
  if (
    diagnosis.status === "ok" &&
    !sameExecutable(diagnosis.candidate, diagnosis.executable)
  ) {
    return "ok-resolved";
  }
  return diagnosis.status;
}

/** Report interpreter fallback before the opener's host and breaker status. */
export function pluginPythonStatusKey(
  diagnosis: Win32PythonDiagnosis | null,
  checking: boolean,
  configured: string,
):
  | "missing-configured"
  | "ok-fallback"
  | "ok-unconfirmed"
  | "ok-runtime-unavailable"
  | ReturnType<typeof pythonStatusKey> {
  if (!checking && diagnosis?.status === "ok") {
    if (
      configured &&
      pythonOverrideStatus(configured, diagnosis) === "fallback"
    ) {
      return "ok-fallback";
    }
    const availability = windowsConPtyStatus(diagnosis, configured, configured);
    if (availability === "unconfirmed") return "ok-unconfirmed";
    if (availability === "runtime-unavailable") return "ok-runtime-unavailable";
  }
  const status = pythonStatusKey(diagnosis, checking);
  if (
    status === "missing" &&
    configured &&
    diagnosis &&
    sameExecutable(diagnosis.executable, configured)
  ) {
    return "missing-configured";
  }
  return status;
}

/**
 * Notifies when {@link runPluginPythonCheck} starts or settles, including
 * rejection, so an open settings tab can update its "checking" status.
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

export interface PluginPythonCheckOptions {
  /** Explicit Recheck includes overrides; automatic checks stay plugin-only. */
  readonly includeProfileOverrides?: boolean;
  /** Explicit Recheck refreshes PATH and diagnoses; startup reuses pending work. */
  readonly refresh?: boolean;
}

/**
 * Runs the plugin-level Python check, publishes the result for the settings
 * tab. Configured values remain untouched; resolutions stay in session state.
 * An overtaken check publishes nothing.
 */
export async function runPluginPythonCheck(
  context: TerminalPlugin,
  spawn: Win32PythonSpawn = DEFAULT_SPAWN,
  locate: Win32PathLocator = DEFAULT_LOCATE,
  {
    includeProfileOverrides = true,
    refresh = true,
  }: PluginPythonCheckOptions = {},
): Promise<Win32PythonDiagnosis> {
  const { settings } = context,
    { pythonExecutable: configured } = settings.value,
    pluginKey = win32PythonConfigurationKey(configured),
    pluginOwner = claimWindowsDiagnosis(pluginKey),
    failuresBeforeCheck = new Map(conPtyRuntimeFailures),
    generation = (pluginCheckGenerations.get(context) ?? 0) + 1,
    // The newest check owns the UI; a moved field has the same effect, since
    // this result describes a value that is no longer configured.
    stale = (): boolean =>
      settings.value.pythonExecutable !== configured ||
      pluginCheckGenerations.get(context) !== generation;
  pluginCheckGenerations.set(context, generation);
  const pendingCheck = { configured, generation };
  pendingPluginChecks.set(context, pendingCheck);
  notifyListeners(pluginDiagnosisListeners.get(context) ?? []);
  try {
    if (refresh) {
      // An installer can add Python to the registry PATH while Obsidian keeps
      // its launch-time environment. Startup shares the existing work instead.
      invalidateSystemPath();
      invalidateWindowsPythonDiagnosis(configured);
    }
    const diagnosis = await checkWindowsPython(context, configured, spawn, {
      locate,
      publish: false,
    });
    // An overtaken check publishes nothing, so it probes no override either.
    if (stale()) return diagnosis;
    const profileValues = new Set<string>();
    if (includeProfileOverrides) {
      for (const profile of Object.values(settings.value.profiles)) {
        if (
          profile.type === "integrated" &&
          Settings.Profile.isCompatible(profile, "win32") &&
          profile.pythonExecutable
        ) {
          profileValues.add(profile.pythonExecutable);
        }
      }
    }
    const profileDiagnoses = new Map<string, Win32PythonDiagnosis>(),
      profileOwners = new Map<string, symbol>(),
      // Only aliases are held back; checkWindowsPython owns configured entries.
      // An alias is valid only while its source probe still owns that entry.
      resolutions: (readonly [
        executable: string,
        diagnosis: Win32PythonDiagnosis,
        source: string,
        pending: Promise<Win32PythonDiagnosis>,
      ])[] = [];
    await Promise.all(
      [...profileValues].map(async (value) => {
        const key = win32PythonConfigurationKey(value, configured);
        profileOwners.set(value, claimWindowsDiagnosis(key));
        // An override that stopped working must not keep its cached success.
        if (refresh) invalidateWindowsPythonDiagnosis(value, configured);
        const checking = checkWindowsPython(context, value, spawn, {
            locate,
            publish: false,
          }),
          pending = diagnoses.get(key),
          resolved = await checking;
        profileDiagnoses.set(value, resolved);
        if (
          !pending ||
          resolved.status !== "ok" ||
          (resolved.transient ?? false)
        )
          return;
        // Alias only the interpreter path: a venv's base host has different
        // packages and must keep its own diagnosis.
        if (
          ![configured, ...profileValues].some((value2) =>
            sameExecutable(resolved.executable, value2),
          )
        ) {
          resolutions.push([resolved.executable, resolved, value, pending]);
        }
      }),
    );
    if (stale()) return diagnosis;
    const checkedConfigurations = new Map<string, Win32PythonDiagnosis>([
      [configured, diagnosis],
      ...profileDiagnoses,
    ]);
    for (const [value, checked] of checkedConfigurations) {
      const key = win32PythonConfigurationKey(value, configured),
        failure = failuresBeforeCheck.get(key);
      if (
        displayOwners.get(key) === (profileOwners.get(value) ?? pluginOwner) &&
        failure !== void 0 &&
        checked.status === "ok" &&
        checked.hostExecutable !== null &&
        !(checked.transient ?? false) &&
        conPtyRuntimeFailures.get(key) === failure
      ) {
        // The identity probe permits a retry; only host readiness proves that
        // ConPTY recovered. Unchecked configurations keep their own breaker.
        conPtyRuntimeFailures.delete(key);
      }
    }
    for (const [value, resolved, source, pending] of resolutions) {
      const key = win32PythonConfigurationKey(value, configured),
        sourceKey = win32PythonConfigurationKey(source, configured);
      if (
        displayOwners.get(sourceKey) === profileOwners.get(source) &&
        diagnoses.get(sourceKey) === pending &&
        !displayOwners.has(key)
      ) {
        diagnoses.set(key, Promise.resolve(resolved));
      }
    }
    pluginDiagnoses.set(context, diagnosis);
    publishWindowsDiagnosis(pluginKey, diagnosis, pluginOwner);
    for (const [value, resolved] of profileDiagnoses) {
      const owner = profileOwners.get(value);
      if (owner) {
        publishWindowsDiagnosis(
          win32PythonConfigurationKey(value, configured),
          resolved,
          owner,
        );
      }
    }
    return diagnosis;
  } finally {
    // A superseded check must not clear the current check's pending state.
    if (pendingPluginChecks.get(context) === pendingCheck) {
      pendingPluginChecks.delete(context);
      notifyListeners(pluginDiagnosisListeners.get(context) ?? []);
    }
  }
}
