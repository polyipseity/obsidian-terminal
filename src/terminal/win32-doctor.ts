/**
 * Windows Python check and exit-code diagnostics. Resolves a usable Python
 * before each Windows PTY construction; results are cached per configured
 * value and plugin fallback for the session.
 */
import {
  type AnyObject,
  SI_PREFIX_SCALE,
  cloneAsWritable,
  dynamicRequire,
  launderUnchecked,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import { cloneDeep } from "es-toolkit/object";
import type { DeepWritable } from "ts-essentials";
import { BUNDLE } from "../imports.js";
import { CHECK_EXECUTABLE_WAIT, PYTHON_REQUIREMENTS } from "../magic.js";
import type { TerminalPlugin } from "../main.js";
import { Settings } from "../settings-data.js";
import { applyEnv, invalidateSystemPath, pathEnvKey } from "./environment.js";
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

/** A command name without a directory or drive, which Windows resolves by
 * search. */
const BARE_NAME = /^[^\\/:]+$/u,
  /** Drive-absolute (`C:\`) or UNC (`\\server\`) directory. */
  ABSOLUTE_DIRECTORY = /^(?:[A-Za-z]:|[\\/])[\\/]/u;

const WIN32_PYTHON_IDENTITY_SOURCE =
  'import sys; print(sys.executable); print("%d.%d.%d" % tuple(sys.version_info[:3])); print(getattr(sys, "_base_executable", "") or sys.executable)';

export type Win32ExitCodeKey =
  | "errors.win32-exit-251"
  | "errors.win32-exit-9009"
  | "errors.win32-exit-c0000142";

/**
 * Maps a Windows exit code to an actionable message key. Returns `null` for
 * every other code, which keeps the generic exit notice.
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
  /** Version reported by the identity probe, empty when unavailable. */
  readonly version: string;
  /** Short, non-localized diagnostic detail for logs. */
  readonly detail: string;
  /** True when a probe timed out, threw, or never ran; callers must persist
   * nothing on it. */
  readonly transient?: boolean;
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
  ret.push(
    { args: [], executable: "python" },
    { args: [], executable: "python3" },
    { args: ["-3"], executable: "py" },
  );
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
    /[\\/]WindowsApps[\\/]/iu.test(executable) &&
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
    return pythonDiagnosis(
      executable,
      candidate,
      "missing",
      `identity probe did not run (${result.errno ?? "no exit code"})`,
      "",
      true,
    );
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
 * ConHost resizer keeps it, and the transient result is never cached.
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
    if (confirmed.transient ?? false) {
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
  let firstFailure: Win32PythonDiagnosis | null = null,
    sawTransient = false;
  for (const entry of candidates) {
    const { args, executable } = entry,
      [diagnosis, identity] = await probePython(
        spawn,
        executable,
        args,
        [executable, ...args].join(" "),
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
      return settled;
    }
    sawTransient ||= settled.transient ?? false;
    firstFailure ??= settled;
  }
  const failure =
    firstFailure ?? pythonDiagnosis("", "", "missing", "no candidate");
  // One transient candidate makes the whole result transient.
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

const diagnoses = new Map<string, Promise<Win32PythonDiagnosis>>(),
  notified = new Set<string>(),
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
  diagnoses.clear();
  notified.clear();
  resizerPackages.clear();
  conPtyRuntimeFailures.clear();
}

const resizerPackages = new Set<string>(),
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
    .map(
      ([name, { maximum, version }]) =>
        `"${name}>=${version.version}${maximum ? `,<=${maximum.version}` : ""}"`,
    )
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
  fallbackPythonExecutable = "",
): void {
  const key = win32PythonConfigurationKey(
    pythonExecutable,
    fallbackPythonExecutable,
  );
  diagnoses.delete(key);
  notified.delete(key);
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
 * Runs the Python check once per configuration and plugin fallback and shows
 * one notice when it fails. Callers await it before constructing a Windows
 * PTY so the same interpreter is used by every helper in that request.
 */
export async function checkWindowsPython(
  context: TerminalPlugin,
  pythonExecutable: string,
  spawn: Win32PythonSpawn = DEFAULT_SPAWN,
  options: {
    readonly locate?: Win32PathLocator;
    readonly notify?: boolean;
  } = {},
): Promise<Win32PythonDiagnosis> {
  const { locate = DEFAULT_LOCATE, notify = true } = options,
    fallbackPythonExecutable = context.settings.value.pythonExecutable,
    key = win32PythonConfigurationKey(
      pythonExecutable,
      fallbackPythonExecutable,
    ),
    cached = diagnoses.get(key);
  if (cached) {
    return cached;
  }
  const diagnosis = diagnoseWindowsPython(
    spawn,
    pythonExecutable,
    locate,
    fallbackPythonExecutable,
  );
  // Retained while in flight so concurrent first callers share one probe.
  diagnoses.set(key, diagnosis);
  let ret: Win32PythonDiagnosis;
  try {
    ret = await diagnosis;
  } catch (error) {
    evictOwnDiagnosis(key, diagnosis);
    throw error;
  }
  const { detail, executable, status, version } = ret;
  if (status === "ok") {
    notified.delete(key);
    if (ret.transient ?? false) {
      // An unconfirmed host is retried by the next open.
      evictOwnDiagnosis(key, diagnosis);
    }
    return ret;
  }
  // Failures are not cached: the notice asks the user to install Python and
  // the next open must re-probe. A missing interpreter fails fast, so this
  // is cheap.
  evictOwnDiagnosis(key, diagnosis);
  const {
    language: { value: i18n },
    settings,
  } = context;
  self.console.warn(`Python check: ${status} (${detail})`);
  if (notify && !notified.has(key)) {
    notified.add(key);
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
 * Aligns each Windows-capable integrated profile's stored backend with its
 * effective Python verdict. An undefined verdict preserves the backend.
 * Returns `true` when any profile changed.
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
  verdict: (
    profile: Settings.Profile.Typed<"integrated">,
  ) => boolean | undefined,
): boolean {
  let changed = false;
  for (const profile of Object.values(profiles)) {
    if (!isWin32Integrated(profile)) {
      continue;
    }
    const pythonUsable = verdict(profile);
    if (pythonUsable === void 0) continue;
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
  pluginDiagnosisListeners = new WeakMap<TerminalPlugin, Set<() => void>>(),
  pluginCheckGenerations = new WeakMap<TerminalPlugin, number>();

/** Windows paths compare case-insensitively. */
function sameExecutable(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Settings-tab status key for a diagnosis. A discovered name maps to the
 * interpreter it runs (`ok-resolved`); a configured path is that interpreter
 * (`ok`). Only the message differs — the download and recheck buttons follow
 * the diagnosis status itself.
 */
export function pythonStatusKey(
  diagnosis: Win32PythonDiagnosis | null,
  checking: boolean,
): "checking" | "ok-resolved" | Win32PythonStatus {
  if (checking || !diagnosis) return "checking";
  if (
    diagnosis.status === "ok" &&
    !sameExecutable(diagnosis.candidate, diagnosis.executable)
  ) {
    return "ok-resolved";
  }
  return diagnosis.status;
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
 * Runs the plugin-level Python check, publishes the result for the settings
 * tab, and aligns stored backends with each profile's effective verdict.
 * Nothing else is written: the plugin-level and profile `pythonExecutable`
 * values are the user's, sync across devices, and stay portable, so every
 * resolution lives in the session cache instead. A check that a newer one
 * overtook — a recheck, or the field edited meanwhile — publishes nothing.
 */
export async function runPluginPythonCheck(
  context: TerminalPlugin,
  spawn: Win32PythonSpawn = DEFAULT_SPAWN,
  locate: Win32PathLocator = DEFAULT_LOCATE,
): Promise<Win32PythonDiagnosis> {
  const { settings } = context,
    { pythonExecutable: configured } = settings.value,
    failuresBeforeCheck = new Map(conPtyRuntimeFailures),
    generation = (pluginCheckGenerations.get(context) ?? 0) + 1,
    // The newest check owns the UI; a moved field has the same effect, since
    // this result describes a value that is no longer configured.
    stale = (pythonExecutable = settings.value.pythonExecutable): boolean =>
      pluginCheckGenerations.get(context) !== generation ||
      pythonExecutable !== configured;
  pluginCheckGenerations.set(context, generation);
  // Refresh both caches: an installer can add Python to the registry PATH
  // while Obsidian keeps its launch-time environment.
  invalidateSystemPath();
  invalidateWindowsPythonDiagnosis(configured);
  const diagnosis = await checkWindowsPython(context, configured, spawn, {
    locate,
    notify: false,
  });
  // An overtaken check publishes nothing, so it probes no override either.
  if (stale()) return diagnosis;
  const profileValues = new Set<string>();
  for (const profile of Object.values(settings.value.profiles)) {
    if (isWin32Integrated(profile) && profile.pythonExecutable) {
      profileValues.add(profile.pythonExecutable);
    }
  }
  const profileDiagnoses = new Map<string, Win32PythonDiagnosis>(),
    // Held back until the generation check below: an overtaken check must not
    // replace the newer one's interpreter, which the opener would then read
    // from the cache without re-probing it.
    resolutions: [string, Win32PythonDiagnosis][] = [];
  await Promise.all(
    [...profileValues].map(async (value) => {
      // An override that stopped working must not keep its cached success.
      invalidateWindowsPythonDiagnosis(value, configured);
      const resolved = await diagnoseWindowsPython(
        spawn,
        value,
        locate,
        configured,
      );
      profileDiagnoses.set(value, resolved);
      if (resolved.status !== "ok" || (resolved.transient ?? false)) return;
      // Publish only after the generation check; opening a terminal uses
      // the same configured candidates and must see this result.
      resolutions.push([value, resolved]);
      // Alias only the interpreter path: a venv's base host has different
      // packages and must keep its own diagnosis.
      if (
        ![configured, ...profileValues].some((value2) =>
          sameExecutable(resolved.executable, value2),
        )
      ) {
        resolutions.push([resolved.executable, resolved]);
      }
    }),
  );
  if (stale()) return diagnosis;
  const checkedConfigurations = new Map(profileDiagnoses).set(
    configured,
    diagnosis,
  );
  for (const [value, checked] of checkedConfigurations) {
    const key = win32PythonConfigurationKey(value, configured),
      failure = failuresBeforeCheck.get(key);
    if (
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
  for (const [value, resolved] of resolutions) {
    diagnoses.set(
      win32PythonConfigurationKey(value, configured),
      Promise.resolve(resolved),
    );
  }
  pluginDiagnoses.set(context, diagnosis);
  const verdict = (
      profile: Settings.Profile.Typed<"integrated">,
    ): boolean | undefined => {
      const effective = profile.pythonExecutable
        ? profileDiagnoses.get(profile.pythonExecutable)
        : diagnosis;
      // A transient result decides nothing, whichever way it points.
      if (!effective || (effective.transient ?? false)) return void 0;
      return effective.status === "ok";
    },
    // `mutate` clones and re-publishes the whole settings tree, so a
    // load that changes nothing must not call it. Rehearse the result on
    // a copy first.
    changed = applyWin32BackendVerdict(
      cloneAsWritable(settings.value.profiles, cloneDeep),
      verdict,
    );
  if (changed) {
    await settings.mutate((settingsM) => {
      // The field may have moved on between the rehearsal and the clone.
      if (stale(settingsM.pythonExecutable)) return;
      applyWin32BackendVerdict(settingsM.profiles, verdict);
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
