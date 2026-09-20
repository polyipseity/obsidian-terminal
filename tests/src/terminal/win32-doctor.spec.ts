/**
 * Unit tests for `src/terminal/win32-doctor.ts`.
 *
 * Covers:
 * - Windows exit-code translation (9009, 0xC0000142, passthrough)
 * - Python candidate resolution order
 * - Version parsing and the 3.9 minimum
 * - Microsoft Store stub detection
 * - `diagnoseWindowsPython` against a stubbed spawn and `PATH` locator:
 *   transient probe failures, the venv base interpreter, and bare names
 * - `checkWindowsPython` caching, its notice budget, and its silent mode
 * - the plugin-level check: demotion, re-promotion, stale results, and that
 *   no Python value is ever written back
 */
import { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepWritable } from "ts-essentials";
import {
  type Win32PathLocator,
  type Win32PythonProcessResult,
  type Win32PythonSpawn,
  applyWin32BackendVerdict,
  checkWindowsResizerPackages,
  classifyPythonResult,
  diagnoseWindowsPython,
  getPluginPythonDiagnosis,
  inheritedPythonExecutable,
  isPythonVersionSupported,
  isStoreStub,
  parsePythonVersion,
  parseWindowsPythonIdentity,
  pythonStatusKey,
  runPluginPythonCheck,
  win32ExitCodeKey,
  win32PathCandidates,
  win32PythonCandidates,
  win32ResizerInstallCommand,
  checkWindowsPython,
  clearWindowsPythonDiagnoses,
  invalidateWindowsPythonDiagnosis,
} from "../../../src/terminal/win32-doctor.js";
import type { TerminalPlugin } from "../../../src/main.js";
import { Settings } from "../../../src/settings-data.js";

function result(
  overrides: Partial<Win32PythonProcessResult> = {},
): Win32PythonProcessResult {
  return { code: 0, stderr: "", stdout: "", ...overrides };
}

/** Canonical path an installed Microsoft Store Python reports. */
const STORE_PACKAGE_PYTHON =
  "C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_3.12.0_x64__qbz5n2kfra8p0\\python.exe";

/** The probe's answer; the base-interpreter line only when one is given, so
 * every other case keeps exercising the two-line answer. */
function identityResult(
  executable = "C:\\Python312\\python.exe",
  version = "3.12.0",
  baseExecutable = "",
): Win32PythonProcessResult {
  return result({
    stdout: `${executable}\r\n${version}\r\n${
      baseExecutable && `${baseExecutable}\r\n`
    }`,
  });
}

/** A `PATH` without the name: a bare name stays as probed. */
const noLocate: Win32PathLocator = async () => null;

describe("src/terminal/win32-doctor.ts", () => {
  describe("win32ExitCodeKey", () => {
    it("translates 9009 to the missing-executable message", () => {
      expect(win32ExitCodeKey(9009)).toBe("errors.win32-exit-9009");
    });

    it("translates 3221225794 (0xC0000142) to the console-init message", () => {
      expect(win32ExitCodeKey(3_221_225_794)).toBe(
        "errors.win32-exit-c0000142",
      );
      expect(win32ExitCodeKey(-1_073_741_502)).toBe(
        "errors.win32-exit-c0000142",
      );
    });

    it("passes every other code and signal through unchanged", () => {
      expect(win32ExitCodeKey(0)).toBeNull();
      expect(win32ExitCodeKey(1)).toBeNull();
      expect(win32ExitCodeKey(9008)).toBeNull();
      expect(win32ExitCodeKey("SIGINT")).toBeNull();
    });
  });

  describe("win32PythonCandidates", () => {
    it("tries the configured executable, then the names, then the launcher", () => {
      expect(win32PythonCandidates("C:\\Python\\python.exe")).toEqual([
        { args: [], executable: "C:\\Python\\python.exe" },
        { args: [], executable: "python" },
        { args: [], executable: "python3" },
        { args: ["-3"], executable: "py" },
      ]);
    });

    it("omits an empty configured executable", () => {
      expect(win32PythonCandidates("")[0]).toEqual({
        args: [],
        executable: "python",
      });
    });
  });

  describe("win32PathCandidates", () => {
    it("tries .com then .exe in each PATH entry, in order", () => {
      expect(
        win32PathCandidates("python", "C:\\Python312\\;D:\\tools"),
      ).toEqual([
        "C:\\Python312\\python.com",
        "C:\\Python312\\python.exe",
        "D:\\tools\\python.com",
        "D:\\tools\\python.exe",
      ]);
    });

    it("tries a name with an extension as written first", () => {
      expect(win32PathCandidates("python3.12", "C:\\Python312")).toEqual([
        "C:\\Python312\\python3.12",
        "C:\\Python312\\python3.12.com",
        "C:\\Python312\\python3.12.exe",
      ]);
    });

    it("skips entries that resolve against the working directory", () => {
      // `.`, a relative folder, and a drive-relative entry all point into
      // whatever directory the terminal starts in.
      expect(
        win32PathCandidates(
          "python.exe",
          '.;bin;C:tools;;"C:\\Program Files\\Python";\\\\server\\share',
        ),
      ).toEqual([
        "C:\\Program Files\\Python\\python.exe",
        "C:\\Program Files\\Python\\python.exe.com",
        "C:\\Program Files\\Python\\python.exe.exe",
        "\\\\server\\share\\python.exe",
        "\\\\server\\share\\python.exe.com",
        "\\\\server\\share\\python.exe.exe",
      ]);
    });
  });

  describe("parsePythonVersion", () => {
    it("reads the version from stdout", () => {
      expect(parsePythonVersion("Python 3.12.1\n")).toBe("3.12.1");
    });

    it("reads a two-component version", () => {
      expect(parsePythonVersion("Python 3.9")).toBe("3.9");
    });

    it("returns an empty string when there is no version", () => {
      expect(parsePythonVersion("")).toBe("");
      expect(parsePythonVersion("bash: python: command not found")).toBe("");
    });
  });

  describe("parseWindowsPythonIdentity", () => {
    it("reads the canonical path and version from the probe", () => {
      expect(
        parseWindowsPythonIdentity(
          "C:\\Program Files\\Python312\\python.exe\r\n3.12.9\r\n",
        ),
      ).toEqual({
        // A two-line answer names no base interpreter of its own.
        baseExecutable: "C:\\Program Files\\Python312\\python.exe",
        executable: "C:\\Program Files\\Python312\\python.exe",
        version: "3.12.9",
      });
    });

    it("reads the base interpreter behind a venv from the third line", () => {
      expect(
        parseWindowsPythonIdentity(
          "C:\\venv\\Scripts\\python.exe\r\n3.12.9\r\nC:\\Python312\\python.exe\r\n",
        ),
      ).toEqual({
        baseExecutable: "C:\\Python312\\python.exe",
        executable: "C:\\venv\\Scripts\\python.exe",
        version: "3.12.9",
      });
    });

    it("rejects a version-only response without sys.executable", () => {
      expect(parseWindowsPythonIdentity("Python 3.12.9\n")).toBeNull();
    });
  });

  describe("isPythonVersionSupported", () => {
    it("accepts 3.9 and up", () => {
      expect(isPythonVersionSupported("3.9.0")).toBe(true);
      expect(isPythonVersionSupported("3.13.2")).toBe(true);
      expect(isPythonVersionSupported("4.0.0")).toBe(true);
    });

    it("rejects older and unparseable versions", () => {
      expect(isPythonVersionSupported("3.8.10")).toBe(false);
      expect(isPythonVersionSupported("2.7.18")).toBe(false);
      expect(isPythonVersionSupported("")).toBe(false);
      expect(isPythonVersionSupported("three.nine")).toBe(false);
    });
  });

  describe("isStoreStub", () => {
    it("detects a WindowsApps alias that reports no identity", () => {
      // `--version` output carries no sys.executable line, so the identity
      // parse fails and the path heuristic still applies.
      expect(
        isStoreStub(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          result({ stdout: "Python 3.12.0" }),
        ),
      ).toBe(true);
    });

    it("detects a WindowsApps alias that prints nothing", () => {
      expect(
        isStoreStub(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          result(),
        ),
      ).toBe(true);
    });

    it("clears a WindowsApps alias that answered the identity probe", () => {
      // An installed Store Python runs through the same alias path.
      expect(
        isStoreStub(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          identityResult(STORE_PACKAGE_PYTHON, "3.12.0"),
        ),
      ).toBe(false);
    });

    it("detects exit code 9009", () => {
      expect(isStoreStub("python", result({ code: 9009 }))).toBe(true);
    });

    it("detects a silent success with no output", () => {
      expect(isStoreStub("python", result({ stdout: "  \n" }))).toBe(true);
    });

    it("leaves a real interpreter alone", () => {
      expect(isStoreStub("python", result({ stdout: "Python 3.12.0\n" }))).toBe(
        false,
      );
    });
  });

  describe("classifyPythonResult", () => {
    it("reports the probed candidate and keeps the canonical path in detail", () => {
      expect(
        classifyPythonResult(
          "python",
          identityResult("C:\\Python311\\python.exe", "3.11.7"),
        ),
      ).toMatchObject({
        candidate: "python",
        detail: "found 3.11.7 at C:\\Python311\\python.exe",
        executable: "python",
        status: "ok",
        version: "3.11.7",
      });
    });

    it("reports too-old below 3.9", () => {
      expect(
        classifyPythonResult("python", identityResult("python", "3.8.10")),
      ).toMatchObject({ status: "too-old", version: "3.8.10" });
    });

    it("marks a timed-out probe transient, not decisively missing", () => {
      expect(
        classifyPythonResult("python", result({ code: null, timedOut: true })),
      ).toMatchObject({ status: "missing", transient: true });
    });

    it("treats only a file that does not exist as decisively missing", () => {
      const missing = classifyPythonResult(
        "C:\\gone\\python.exe",
        result({ code: null, errno: "ENOENT" }),
      );
      expect(missing).toMatchObject({ status: "missing" });
      expect(missing.transient ?? false).toBe(false);
    });

    it.each(["EPERM", "EACCES", "EBUSY", "UNKNOWN", void 0])(
      "marks a probe that never ran (%s) transient",
      (errno) => {
        // Antivirus holding python.exe is not an uninstalled Python.
        expect(
          classifyPythonResult(
            "python",
            result({ code: null, ...(errno === void 0 ? {} : { errno }) }),
          ),
        ).toMatchObject({ status: "missing", transient: true });
      },
    );

    it("keeps a locked WindowsApps alias transient, not a store stub", () => {
      expect(
        classifyPythonResult(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          result({ code: null, errno: "EPERM" }),
        ),
      ).toMatchObject({ status: "missing", transient: true });
    });

    it("keeps the 9009 store stub decisive", () => {
      const stub = classifyPythonResult("python", result({ code: 9009 }));
      expect(stub).toMatchObject({ status: "store-stub" });
      expect(stub.transient ?? false).toBe(false);
    });

    it("rejects a supported version without canonical identity", () => {
      expect(
        classifyPythonResult(
          "python",
          result({ stderr: "Python 3.12.0\n", stdout: "" }),
        ),
      ).toMatchObject({ status: "missing", version: "3.12.0" });
    });

    it("accepts an installed Store Python behind the WindowsApps alias", () => {
      expect(
        classifyPythonResult(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
          identityResult(STORE_PACKAGE_PYTHON, "3.12.0"),
        ),
      ).toMatchObject({
        executable:
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
        status: "ok",
        version: "3.12.0",
      });
    });

    it("keeps store-stub for a WindowsApps alias without identity output", () => {
      expect(
        classifyPythonResult(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          result({ stdout: "Python 3.12.0" }),
        ),
      ).toMatchObject({ status: "store-stub" });
    });

    it("reports missing when nothing resembles a version", () => {
      expect(
        classifyPythonResult(
          "python",
          result({ code: 1, stderr: "not recognized" }),
        ),
      ).toMatchObject({ status: "missing" });
    });
  });

  describe("diagnoseWindowsPython", () => {
    it("returns the profile executable when it works", async () => {
      const calls: Array<readonly [string, readonly string[]]> = [],
        spawn: Win32PythonSpawn = async (executable, args) => {
          calls.push([executable, args]);
          return identityResult("C:\\Python312\\python.exe");
        };
      await expect(
        diagnoseWindowsPython(spawn, "C:\\Python312\\python.exe"),
      ).resolves.toEqual({
        candidate: "C:\\Python312\\python.exe",
        detail: "found 3.12.0 at C:\\Python312\\python.exe",
        executable: "C:\\Python312\\python.exe",
        hostExecutable: "C:\\Python312\\python.exe",
        status: "ok",
        version: "3.12.0",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe("C:\\Python312\\python.exe");
      expect(calls[0]?.[1].slice(0, 1)).toEqual(["-c"]);
    });

    it("falls through the resolution order until one works", async () => {
      const calls: string[] = [],
        spawn: Win32PythonSpawn = async (executable) => {
          calls.push(executable);
          if (executable === "python3") {
            return identityResult("C:\\Python310\\python.exe", "3.10.0");
          }
          return result({ code: 9009 });
        };
      await expect(
        diagnoseWindowsPython(spawn, "", noLocate),
      ).resolves.toMatchObject({
        // The canonical path was probed and denied, so the probed name —
        // which launches PID-preserving — stays the spawn target.
        candidate: "python3",
        executable: "python3",
        hostExecutable: "python3",
        status: "ok",
      });
      expect(calls).toEqual(["python", "python3", "C:\\Python310\\python.exe"]);
    });

    describe("a bare name whose canonical path cannot be executed", () => {
      // An installed Microsoft Store Python: the alias runs, the package
      // path it reports does not.
      const alias =
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
        storeSpawn =
          (calls: string[], aliasRuns = true): Win32PythonSpawn =>
          async (executable) => {
            calls.push(executable);
            if (
              executable === "python" ||
              (aliasRuns && executable === alias)
            ) {
              return identityResult(STORE_PACKAGE_PYTHON);
            }
            return result({ code: 1, stderr: "Access is denied." });
          };

      it("spawns the absolute path PATH holds for it, never the bare name", async () => {
        const calls: string[] = [],
          locate = vi.fn<Win32PathLocator>(async () => alias);
        await expect(
          diagnoseWindowsPython(storeSpawn(calls), "", locate),
        ).resolves.toMatchObject({
          // libuv would search the terminal's directory — possibly a vault —
          // for a bare `python` before PATH.
          candidate: "python",
          executable: alias,
          hostExecutable: alias,
          status: "ok",
        });
        expect(locate.mock.calls).toEqual([["python"]]);
        // The located path answered a probe of its own before it was used.
        expect(calls).toEqual(["python", STORE_PACKAGE_PYTHON, alias]);
      });

      it("does not probe again a path PATH holds that was just rejected", async () => {
        const calls: string[] = [],
          // Windows paths compare case-insensitively.
          locate: Win32PathLocator = async () =>
            STORE_PACKAGE_PYTHON.toLowerCase();
        await expect(
          diagnoseWindowsPython(storeSpawn(calls), "", locate),
        ).resolves.toMatchObject({
          candidate: "python",
          executable: "python",
          hostExecutable: "python",
          status: "ok",
        });
        expect(calls).toEqual(["python", STORE_PACKAGE_PYTHON]);
      });

      it.each<readonly [string, Win32PathLocator, boolean]>([
        ["PATH does not hold it", noLocate, true],
        ["the located path does not run", async () => alias, false],
        [
          "the PATH search fails",
          async () => {
            throw new Error("EIO");
          },
          true,
        ],
      ])("keeps the probed name when %s", async (_why, locate, aliasRuns) => {
        vi.spyOn(console, "debug").mockImplementation(vi.fn());
        await expect(
          diagnoseWindowsPython(storeSpawn([], aliasRuns), "", locate),
        ).resolves.toMatchObject({
          candidate: "python",
          executable: "python",
          hostExecutable: "python",
          status: "ok",
        });
      });

      it("approves nothing when the located path proves nothing", async () => {
        // The alias is locked, not broken: spawning the bare name instead
        // would run whatever the terminal's directory holds for it.
        const spawn: Win32PythonSpawn = async (executable) =>
          executable === alias
            ? result({ code: null, errno: "EACCES" })
            : storeSpawn([])(executable, []);
        await expect(
          diagnoseWindowsPython(spawn, "", async () => alias),
        ).resolves.toMatchObject({ status: "missing", transient: true });
      });

      it("searches PATH for bare names only", async () => {
        const locate = vi.fn<Win32PathLocator>(async () => alias),
          relative = ".venv\\Scripts\\python.exe",
          spawn: Win32PythonSpawn = async (executable) =>
            executable === relative
              ? identityResult("C:\\project\\.venv\\Scripts\\python.exe")
              : result({ code: 1, stderr: "Access is denied." });
        await expect(
          diagnoseWindowsPython(spawn, relative, locate),
        ).resolves.toMatchObject({ executable: relative, status: "ok" });
        expect(locate).not.toHaveBeenCalled();
      });
    });

    describe("a venv interpreter", () => {
      const venv = "C:\\venv\\Scripts\\python.exe",
        base = "C:\\Python312\\python.exe";

      it("hosts ConPTY on the base interpreter once it answers", async () => {
        const calls: string[] = [],
          spawn: Win32PythonSpawn = async (executable) => {
            calls.push(executable);
            return executable === venv
              ? identityResult(venv, "3.12.0", base)
              : identityResult(base, "3.12.0", base);
          };
        await expect(diagnoseWindowsPython(spawn, venv)).resolves.toMatchObject(
          {
            // The venv holds the packages; its python.exe only redirects.
            candidate: venv,
            executable: venv,
            hostExecutable: base,
            status: "ok",
          },
        );
        expect(calls).toEqual([venv, base]);
      });

      it("hosts ConPTY on the venv when the base does not answer", async () => {
        const spawn: Win32PythonSpawn = async (executable) =>
          executable === venv
            ? identityResult(venv, "3.12.0", base)
            : result({ code: null, errno: "ENOENT" });
        await expect(diagnoseWindowsPython(spawn, venv)).resolves.toMatchObject(
          {
            executable: venv,
            hostExecutable: venv,
            status: "ok",
          },
        );
      });

      it("confirms no host when the base probe proves nothing", async () => {
        // Hosting on the venv's launcher would fail the PID check and condemn
        // the runtime for the session. The venv itself answered, so the
        // ConHost resizer keeps it, and the transient result is not cached.
        const spawn: Win32PythonSpawn = async (executable) =>
          executable === venv
            ? identityResult(venv, "3.12.0", base)
            : result({ code: null, errno: "EACCES" });
        await expect(diagnoseWindowsPython(spawn, venv)).resolves.toMatchObject(
          {
            executable: venv,
            hostExecutable: null,
            status: "ok",
            transient: true,
          },
        );
      });

      it("resolves the base behind a name that runs the venv", async () => {
        const calls: string[] = [],
          spawn: Win32PythonSpawn = async (executable) => {
            calls.push(executable);
            return executable === base
              ? identityResult(base, "3.12.0", base)
              : identityResult(venv, "3.12.0", base);
          };
        await expect(diagnoseWindowsPython(spawn, "")).resolves.toMatchObject({
          candidate: "python",
          executable: venv,
          hostExecutable: base,
          status: "ok",
        });
        expect(calls).toEqual(["python", venv, base]);
      });
    });

    it("spawns the real interpreter behind an install-manager shim", async () => {
      const canonical =
          "C:\\Users\\a\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",
        spawn: Win32PythonSpawn = async (executable) =>
          executable === "python" || executable === canonical
            ? identityResult(canonical, "3.14.7")
            : result({ code: 9009 });
      await expect(diagnoseWindowsPython(spawn, "")).resolves.toMatchObject({
        /*
         * A shim runs the interpreter as a child process, which breaks the
         * PTY's process identity; the canonical path that answered its own
         * probe is the spawn target. The name stays what the user sees.
         */
        candidate: "python",
        executable: canonical,
        status: "ok",
        version: "3.14.7",
      });
    });

    it("approves no shim whose interpreter proved nothing", async () => {
      const canonical =
          "C:\\Users\\a\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",
        spawn: Win32PythonSpawn = async (executable) =>
          executable === "python"
            ? identityResult(canonical, "3.14.7")
            : executable === canonical
              ? result({ code: null, timedOut: true })
              : result({ code: 9009 });
      // The shim itself fails the PTY's PID check, so a confirmation that
      // timed out must not leave it cached as the spawn target.
      await expect(
        diagnoseWindowsPython(spawn, "", noLocate),
      ).resolves.toMatchObject({ status: "missing", transient: true });
    });

    it("reports the store stub when every candidate is the stub", async () => {
      const spawn: Win32PythonSpawn = async () => result({ code: 9009 });
      await expect(
        diagnoseWindowsPython(spawn, "python"),
      ).resolves.toMatchObject({ executable: "python", status: "store-stub" });
    });

    it("reports the configured executable's failure, not a later one", async () => {
      const spawn: Win32PythonSpawn = async (executable) =>
        executable === "C:\\old\\python.exe"
          ? identityResult("C:\\old\\python.exe", "3.8.0")
          : result({ code: 1, stderr: "not recognized" });
      await expect(
        diagnoseWindowsPython(spawn, "C:\\old\\python.exe"),
      ).resolves.toMatchObject({
        executable: "C:\\old\\python.exe",
        status: "too-old",
        version: "3.8.0",
      });
    });

    it("survives a spawn that throws", async () => {
      const spawn: Win32PythonSpawn = async () => {
        throw new Error("ENOENT");
      };
      await expect(
        diagnoseWindowsPython(spawn, "python"),
      ).resolves.toMatchObject({ executable: "python", status: "missing" });
    });

    it("canonicalizes the py -3 fallback and confirms the canonical path", async () => {
      const canonical = "C:\\Users\\test\\Python312\\python.exe",
        calls: Array<readonly [string, readonly string[]]> = [],
        spawn: Win32PythonSpawn = async (executable, args) => {
          calls.push([executable, args]);
          if (executable === "py" || executable === canonical) {
            return identityResult(canonical, "3.12.9");
          }
          return result({ code: 9009 });
        };

      const diagnosis = await diagnoseWindowsPython(
        spawn,
        "C:\\missing\\python.exe",
      );

      expect(diagnosis).toMatchObject({
        candidate: "py -3",
        executable: canonical,
        status: "ok",
        version: "3.12.9",
      });
      expect(calls.map(([executable]) => executable)).toEqual([
        "C:\\missing\\python.exe",
        "python",
        "python3",
        "py",
        canonical,
      ]);
      expect(calls[3]?.[1].slice(0, 2)).toEqual(["-3", "-c"]);
      // The canonical path was probed on its own before it was returned.
      expect(calls[4]?.[1]).toEqual(["-c", calls[3]?.[1][2] ?? ""]);
    });

    it.each<
      readonly [
        canonicalFailure: string,
        probe: () => Win32PythonProcessResult,
        transient: boolean,
      ]
    >([
      [
        "is denied",
        (): Win32PythonProcessResult =>
          result({ code: 1, stderr: "Access is denied." }),
        false,
      ],
      [
        "never runs",
        (): Win32PythonProcessResult => {
          throw new Error("EACCES");
        },
        true,
      ],
      [
        "times out",
        (): Win32PythonProcessResult => result({ code: null, timedOut: true }),
        true,
      ],
      [
        "is locked",
        (): Win32PythonProcessResult => result({ code: null, errno: "EBUSY" }),
        true,
      ],
    ])(
      "does not run the launcher when its canonical path %s",
      async (_canonicalFailure, probe, transient) => {
        vi.spyOn(console, "debug").mockImplementation(vi.fn());
        const canonical = "C:\\Users\\test\\Python312\\python.exe",
          calls: string[] = [],
          spawn: Win32PythonSpawn = async (executable) => {
            calls.push(executable);
            if (executable === "py") {
              return identityResult(canonical, "3.12.9");
            }
            if (executable === canonical) {
              return probe();
            }
            return result({ code: 9009 });
          };

        const diagnosis = await diagnoseWindowsPython(spawn, "");
        expect(diagnosis).toMatchObject({
          // The launcher's arguments cannot travel to the PTY spawn, so an
          // unconfirmed canonical path disqualifies it and the first failure
          // stands.
          candidate: "python",
          status: "store-stub",
        });
        // A confirmation that proved nothing must not read as "no Python".
        expect(diagnosis.transient ?? false).toBe(transient);
        expect(calls).toEqual(["python", "python3", "py", canonical]);
      },
    );
  });

  describe("inheritedPythonExecutable", () => {
    it("prefers the profile value and falls back to the plugin value", () => {
      expect(inheritedPythonExecutable("", "C:\\Python312\\python.exe")).toBe(
        "C:\\Python312\\python.exe",
      );
      expect(
        inheritedPythonExecutable(
          "C:\\Profile\\python.exe",
          "C:\\Python312\\python.exe",
        ),
      ).toBe("C:\\Profile\\python.exe");
      expect(inheritedPythonExecutable("", "")).toBe("");
    });
  });

  describe("pythonStatusKey", () => {
    const found = classifyPythonResult(
      "C:\\Python312\\python.exe",
      identityResult(),
    );

    it("tells a discovered name apart from a configured path", () => {
      expect(pythonStatusKey({ ...found, candidate: "python" }, false)).toBe(
        "ok-resolved",
      );
      expect(pythonStatusKey(found, false)).toBe("ok");
      expect(
        pythonStatusKey(
          { ...found, candidate: "c:\\python312\\PYTHON.EXE" },
          false,
        ),
      ).toBe("ok");
    });

    it("reports checking before a result and while rechecking", () => {
      expect(pythonStatusKey(null, false)).toBe("checking");
      expect(pythonStatusKey(found, true)).toBe("checking");
    });

    it("passes a failure status through", () => {
      expect(
        pythonStatusKey(
          classifyPythonResult("python", result({ code: 9009 })),
          false,
        ),
      ).toBe("store-stub");
    });
  });
});

describe("checkWindowsPython session cache", () => {
  /** Message keys rendered by the failure notice, newest last. */
  const noticeKeys: string[] = [];

  afterEach(() => {
    clearWindowsPythonDiagnoses();
    noticeKeys.length = 0;
    vi.restoreAllMocks();
  });

  function context(): TerminalPlugin {
    return {
      language: {
        onChangeLanguage: { listen: vi.fn(() => vi.fn()) },
        value: {
          // The notice is the only caller, so each call is one shown notice.
          t: (key: string): string => {
            noticeKeys.push(key);
            return key;
          },
        },
      },
      settings: { value: { errorNoticeTimeout: 0 } },
    } as unknown as TerminalPlugin;
  }

  it("probes once for a usable interpreter", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult());
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "ok",
    );
    const probes = spawn.mock.calls.length;
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "ok",
    );
    expect(spawn.mock.calls).toHaveLength(probes);
  });

  it("re-probes a venv whose ConPTY host was not confirmed", async () => {
    const venv = "C:\\venv\\Scripts\\python.exe",
      base = "C:\\Python312\\python.exe";
    let locked = true;
    const spawn: Win32PythonSpawn = async (executable) =>
      executable === venv
        ? identityResult(venv, "3.12.0", base)
        : locked
          ? result({ code: null, errno: "EACCES" })
          : identityResult(base, "3.12.0", base);
    await expect(
      checkWindowsPython(context(), venv, spawn),
    ).resolves.toMatchObject({ hostExecutable: null, status: "ok" });
    // The lock was momentary; a cached answer would keep ConPTY off the
    // profile for the whole session.
    locked = false;
    await expect(
      checkWindowsPython(context(), venv, spawn),
    ).resolves.toMatchObject({ hostExecutable: base, status: "ok" });
    expect(noticeKeys).toEqual([]);
  });

  it("re-probes after a failure so a mid-session install is picked up", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    let installed = false;
    const spawn = vi.fn(async () => {
      if (!installed) throw new Error("ENOENT");
      return identityResult();
    }) as Win32PythonSpawn;
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "missing",
    );
    // The notice told the user to install Python; the next open must see it.
    installed = true;
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "ok",
    );
  });

  it("shows no notice for a silent check and keeps the budget intact", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(vi.fn()),
      spawn = vi.fn(async () => result({ code: 9009 })) as Win32PythonSpawn,
      ctx = context();

    expect(
      (await checkWindowsPython(ctx, "python", spawn, { notify: false }))
        .status,
    ).toBe("store-stub");
    expect(noticeKeys).toHaveLength(0);
    // The log line stays in both modes.
    expect(warn).toHaveBeenCalledTimes(1);

    // The silent check spent nothing, so the interactive one still notifies.
    expect((await checkWindowsPython(ctx, "python", spawn)).status).toBe(
      "store-stub",
    );
    expect(noticeKeys).toEqual(["errors.win32-python-store-stub"]);

    // And the notice is still shown once per session per configured value.
    await checkWindowsPython(ctx, "python", spawn);
    expect(noticeKeys).toHaveLength(1);
  });

  it("re-probes after a silent failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    let installed = false;
    const spawn = vi.fn(async () => {
        if (!installed) throw new Error("ENOENT");
        return identityResult();
      }) as Win32PythonSpawn,
      ctx = context();
    expect(
      (await checkWindowsPython(ctx, "python", spawn, { notify: false }))
        .status,
    ).toBe("missing");
    installed = true;
    expect(
      (await checkWindowsPython(ctx, "python", spawn, { notify: false }))
        .status,
    ).toBe("ok");
    expect(noticeKeys).toHaveLength(0);
  });

  it("re-probes after a runtime failure invalidates a cached success", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      ctx = context();
    await checkWindowsPython(ctx, "python", spawn);
    const probes = spawn.mock.calls.length;
    invalidateWindowsPythonDiagnosis("python");
    await checkWindowsPython(ctx, "python", spawn);
    expect(spawn.mock.calls.length).toBeGreaterThan(probes);
  });

  it("shares one probe between concurrent first callers", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      ctx = context();
    await checkWindowsPython(ctx, "python", spawn);
    const probes = spawn.mock.calls.length;
    clearWindowsPythonDiagnoses();
    spawn.mockClear();
    const [a, b] = await Promise.all([
      checkWindowsPython(ctx, "python", spawn),
      checkWindowsPython(ctx, "python", spawn),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(spawn.mock.calls).toHaveLength(probes);
  });
});

describe("win32ResizerInstallCommand", () => {
  const specs =
    '--upgrade "psutil>=5.9.5,<=7.1.1" "pywinctl>=0.0.50" "typing_extensions>=4.7.1"';

  it("targets the exact interpreter with the manifest's minimums", () => {
    expect(win32ResizerInstallCommand("C:\\Python312\\python.exe")).toBe(
      `C:\\Python312\\python.exe -m pip install ${specs}`,
    );
  });

  it("uses the PowerShell call operator for a path with spaces", () => {
    expect(
      win32ResizerInstallCommand("C:\\Program Files\\Python\\python.exe"),
    ).toBe(`& 'C:\\Program Files\\Python\\python.exe' -m pip install ${specs}`);
  });

  it.each(["C:\\R&D\\python.exe", "C:\\Python(x86)\\python.exe"])(
    "quotes a path with shell-special characters and no space (%s)",
    (python) => {
      expect(win32ResizerInstallCommand(python)).toBe(
        `& '${python}' -m pip install ${specs}`,
      );
    },
  );

  it("keeps PowerShell expansion characters and apostrophes literal", () => {
    expect(
      win32ResizerInstallCommand("C:\\O'Brien\\$python`3\\python.exe"),
    ).toBe(`& 'C:\\O''Brien\\$python\`3\\python.exe' -m pip install ${specs}`);
  });

  it("escapes smart apostrophes that PowerShell treats as string delimiters", () => {
    expect(
      win32ResizerInstallCommand("C:\\O\u2019Brien\\python.exe"),
    ).toContain("& 'C:\\O\u2019\u2019Brien\\python.exe' -m pip install");
  });
});

describe("checkWindowsResizerPackages", () => {
  afterEach(() => {
    clearWindowsPythonDiagnoses();
  });

  it("caches a success and skips the probe next time", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => result());
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
    expect(spawn.mock.calls).toHaveLength(1);
  });

  it("re-probes after a failure so a pip install is picked up", async () => {
    let installed = false;
    const spawn = vi.fn(async () =>
      installed ? result() : result({ code: 1, stderr: "ModuleNotFoundError" }),
    ) as Win32PythonSpawn;
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(false);
    installed = true;
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
  });

  it("imports every manifest package in one probe", async () => {
    const seen: (readonly string[])[] = [],
      spawn = (async (_executable, args) => {
        seen.push(args);
        return result();
      }) as Win32PythonSpawn;
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
    expect(seen).toEqual([
      ["-c", "import psutil, pywinctl, typing_extensions"],
    ]);
  });
});

describe("applyWin32BackendVerdict", () => {
  function integratedWin32(
    overrides: Partial<Settings.Profile.Typed<"integrated">> = {},
  ): DeepWritable<Settings.Profile> {
    return {
      ...Settings.Profile.DEFAULTS.integrated,
      platforms: { win32: true },
      ...overrides,
    } as DeepWritable<Settings.Profile>;
  }

  it("demotes ConPTY profiles and records provenance when Python is missing", () => {
    const profiles = { a: integratedWin32() };
    expect(applyWin32BackendVerdict(profiles, () => false)).toBe(true);
    expect(profiles.a).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
  });

  it("re-promotes only auto-demoted profiles, never a user choice", () => {
    const profiles = {
      demoted: integratedWin32({
        win32Backend: "legacy",
        win32BackendAutoDemoted: true,
      }),
      userChoice: integratedWin32({ win32Backend: "legacy" }),
    };
    expect(applyWin32BackendVerdict(profiles, () => true)).toBe(true);
    expect(profiles.demoted).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(profiles.userChoice).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: false,
    });
  });

  it("clears a stale marker on a profile that already runs ConPTY", () => {
    const profiles = {
      a: integratedWin32({ win32BackendAutoDemoted: true }),
    };
    expect(applyWin32BackendVerdict(profiles, () => true)).toBe(true);
    expect(profiles.a).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
  });

  it("leaves incompatible and non-integrated profiles alone", () => {
    const profiles = {
      external: {
        ...Settings.Profile.DEFAULTS.external,
        platforms: { win32: true },
      },
      unix: integratedWin32({ platforms: { linux: true } }),
    } as unknown as DeepWritable<Settings.Profiles>;
    expect(applyWin32BackendVerdict(profiles, () => false)).toBe(false);
    expect(profiles["unix"]).toMatchObject({ win32Backend: "conpty" });
  });

  it("reports an unchanged result as a no-op", () => {
    const profiles = {
      a: integratedWin32({ win32Backend: "legacy" }),
    };
    expect(applyWin32BackendVerdict(profiles, () => false)).toBe(false);
    expect(applyWin32BackendVerdict(profiles, () => true)).toBe(false);
  });
});

describe("runPluginPythonCheck", () => {
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.restoreAllMocks();
  });

  function reconcileContext(initial: {
    readonly defaultProfile?: string | null;
    readonly pythonExecutable?: string;
    readonly profiles?: Record<string, unknown>;
  }): {
    readonly context: TerminalPlugin;
    readonly value: {
      pythonExecutable: string;
      profiles: DeepWritable<Settings.Profiles>;
    };
    readonly write: ReturnType<typeof vi.fn>;
  } {
    const value = {
        defaultProfile: initial.defaultProfile ?? null,
        errorNoticeTimeout: 0,
        profiles: (initial.profiles ?? {}) as DeepWritable<Settings.Profiles>,
        pythonExecutable: initial.pythonExecutable ?? "",
      },
      write = vi.fn(async () => {}),
      context = {
        language: { value: { t: (key: string): string => key } },
        settings: {
          mutate: async (mutator: (settings: typeof value) => unknown) => {
            await mutator(value);
          },
          value,
          write,
        },
      } as unknown as TerminalPlugin;
    return { context, value, write };
  }

  function win32Conpty(
    overrides: Partial<Settings.Profile.Typed<"integrated">> = {},
  ): DeepWritable<Settings.Profile.Typed<"integrated">> {
    return {
      ...Settings.Profile.DEFAULTS.integrated,
      platforms: { win32: true },
      ...overrides,
    } as DeepWritable<Settings.Profile.Typed<"integrated">>;
  }

  it("leaves an empty plugin-level field empty and publishes the result", async () => {
    const { context: ctx, value, write } = reconcileContext({}),
      spawn = (async (executable) =>
        executable === "python" || executable === "C:\\Python312\\python.exe"
          ? identityResult()
          : result({ code: 9009 })) as Win32PythonSpawn;
    const diagnosis = await runPluginPythonCheck(ctx, spawn);
    expect(diagnosis).toMatchObject({
      candidate: "python",
      executable: "C:\\Python312\\python.exe",
      status: "ok",
    });
    // The field syncs across devices; the resolution stays in this session.
    expect(value.pythonExecutable).toBe("");
    expect(getPluginPythonDiagnosis(ctx)).toBe(diagnosis);
    expect(write).not.toHaveBeenCalled();
  });

  it("publishes nothing from a check a newer one overtook", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const oldPath = "C:\\Old\\python.exe",
      newPath = "D:\\New\\python.exe",
      {
        context: ctx,
        value,
        write,
      } = reconcileContext({
        profiles: { inherited: win32Conpty() },
        pythonExecutable: oldPath,
      }),
      finishOld: ((probe: Win32PythonProcessResult) => void)[] = [],
      oldProbe = new Promise<Win32PythonProcessResult>((resolve) => {
        finishOld.push(resolve);
      }),
      spawn = (async (executable) => {
        if (executable === oldPath) return oldProbe;
        if (executable === newPath) return identityResult(newPath);
        return result({ code: 9009 });
      }) as Win32PythonSpawn;
    const oldCheck = runPluginPythonCheck(ctx, spawn);
    // The user types another interpreter and rechecks while the first probe
    // is still waiting.
    value.pythonExecutable = newPath;
    const newer = await runPluginPythonCheck(ctx, spawn);
    expect(newer.status).toBe("ok");
    finishOld[0]?.(result({ code: 9009 }));
    expect((await oldCheck).status).not.toBe("ok");
    // The old failure neither replaces the status nor demotes anything.
    expect(getPluginPythonDiagnosis(ctx)).toBe(newer);
    expect(value.profiles["inherited"]).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("probes no profile override once its first probe is overtaken", async () => {
    const oldPath = "C:\\Old\\python.exe",
      venv = "C:\\venv\\Scripts\\python.exe",
      { context: ctx, value } = reconcileContext({
        profiles: { custom: win32Conpty({ pythonExecutable: venv }) },
        pythonExecutable: oldPath,
      }),
      finishOld: ((probe: Win32PythonProcessResult) => void)[] = [],
      oldProbe = new Promise<Win32PythonProcessResult>((resolve) => {
        finishOld.push(resolve);
      }),
      spawn = vi.fn<Win32PythonSpawn>(async (executable) =>
        executable === oldPath ? oldProbe : identityResult(executable),
      );
    const oldCheck = runPluginPythonCheck(ctx, spawn);
    // The field moves on while the first probe is still waiting.
    value.pythonExecutable = "D:\\New\\python.exe";
    finishOld[0]?.(identityResult(oldPath));
    expect((await oldCheck).status).toBe("ok");
    expect(spawn.mock.calls.map(([executable]) => executable)).toEqual([
      oldPath,
    ]);
    expect(getPluginPythonDiagnosis(ctx)).toBeNull();
  });

  it("re-probes a profile override that stopped working", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const venv = "C:\\venv\\Scripts\\python.exe";
    let installed = true;
    const { context: ctx, value } = reconcileContext({
        profiles: { custom: win32Conpty({ pythonExecutable: venv }) },
      }),
      spawn = vi.fn<Win32PythonSpawn>(async (executable) =>
        executable === venv && installed
          ? identityResult(venv)
          : result({ code: 9009 }),
      );
    await runPluginPythonCheck(ctx, spawn);
    expect(value.profiles["custom"]).toMatchObject({ win32Backend: "conpty" });
    // The opener's cache holds the override's success from the first check.
    const probes = spawn.mock.calls.length;
    await checkWindowsPython(ctx, venv, spawn, { notify: false });
    expect(spawn.mock.calls).toHaveLength(probes);

    installed = false;
    await runPluginPythonCheck(ctx, spawn);
    expect(value.profiles["custom"]).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
    // ...and the next open re-probes instead of reusing it.
    const probes2 = spawn.mock.calls.length;
    await checkWindowsPython(ctx, venv, spawn, { notify: false });
    expect(spawn.mock.calls.length).toBeGreaterThan(probes2);
  });

  it("keeps a user-set field even when discovery finds another Python", async () => {
    vi.spyOn(console, "debug").mockImplementation(vi.fn());
    const { context: ctx, value } = reconcileContext({
        pythonExecutable: "C:\\user\\python.exe",
      }),
      spawn = (async (executable) =>
        executable === "python"
          ? identityResult()
          : result({ code: 9009 })) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn, noLocate)).status).toBe(
      "ok",
    );
    expect(value.pythonExecutable).toBe("C:\\user\\python.exe");
  });

  it("refreshes a cached registry PATH and re-promotes after an install", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const inheritedPath = "C:\\Windows\\System32",
      pythonDirectory = "C:\\Python312";
    let registryPath = inheritedPath;
    const registrySpawn = vi.fn((_command: string, args: readonly string[]) => {
      const child = new ChildProcess();
      child.stdout = Readable.from([
        args[1] === "HKCU\\Environment"
          ? ""
          : `Path REG_SZ ${registryPath}\r\n`,
      ]);
      child.stdout.once("end", () => child.emit("close", 0));
      window.setTimeout(() => child.emit("spawn"), 0);
      return child;
    });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows");
    vi.doMock("../../../src/imports.js", () => ({
      BUNDLE: new Map<string, () => unknown>([
        [
          "node:child_process",
          () => ({ execFile: vi.fn(), spawn: registrySpawn }),
        ],
        ["node:process", () => ({ env: { Path: inheritedPath } })],
      ]),
    }));
    // Reload both modules together so this test owns the real PATH cache.
    vi.resetModules();
    try {
      const { applyEnv, pathEnvKey } =
          await import("../../../src/terminal/environment.js"),
        { runPluginPythonCheck: recheck } =
          await import("../../../src/terminal/win32-doctor.js"),
        { context: ctx, value } = reconcileContext({
          profiles: {
            auto: win32Conpty(),
            userChoice: win32Conpty({ win32Backend: "legacy" }),
          },
        }),
        spawn = vi.fn<Win32PythonSpawn>(async (executable) => {
          // The production spawn uses this same environment builder.
          const env = await applyEnv();
          return executable === "C:\\Python312\\python.exe" ||
            (executable === "python" &&
              env[pathEnvKey(env)]?.split(";").includes(pythonDirectory))
            ? identityResult()
            : result({ code: 9009 });
        });
      expect((await recheck(ctx, spawn)).status).not.toBe("ok");
      expect(value.profiles["auto"]).toMatchObject({
        win32Backend: "legacy",
        win32BackendAutoDemoted: true,
      });
      // Only the registry changes; Obsidian still has its launch-time PATH.
      registryPath = `${inheritedPath};${pythonDirectory}`;
      expect((await applyEnv())["Path"]).toBe(inheritedPath);
      expect(registrySpawn).toHaveBeenCalledTimes(2);
      expect((await recheck(ctx, spawn)).status).toBe("ok");
      expect(registrySpawn).toHaveBeenCalledTimes(4);
      expect(value.profiles["auto"]).toMatchObject({
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
      expect(value.profiles["userChoice"]).toMatchObject({
        win32Backend: "legacy",
        win32BackendAutoDemoted: false,
      });
    } finally {
      vi.doUnmock("../../../src/imports.js");
      vi.resetModules();
    }
  });

  it("leaves stored backends alone on a transient probe failure", async () => {
    // One timed-out candidate might have been the working interpreter, so
    // "missing" is not decisive: nothing is demoted and nothing is written.
    const {
        context: ctx,
        value,
        write,
      } = reconcileContext({
        profiles: { auto: win32Conpty() },
      }),
      spawn = (async (executable) =>
        executable === "python3"
          ? result({ code: null, timedOut: true })
          : result({ code: 9009 })) as Win32PythonSpawn;
    const diagnosis = await runPluginPythonCheck(ctx, spawn);
    expect(diagnosis.status).not.toBe("ok");
    expect(diagnosis.transient).toBe(true);
    expect(value.profiles["auto"]).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves stored backends alone when no probe could start", async () => {
    // Antivirus locking python.exe during the check: every candidate fails
    // to launch, none of them says Python is gone.
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const venv = "C:\\venv\\Scripts\\python.exe",
      {
        context: ctx,
        value,
        write,
      } = reconcileContext({
        profiles: {
          inherited: win32Conpty(),
          override: win32Conpty({ pythonExecutable: venv }),
        },
      }),
      spawn = (async () =>
        result({ code: null, errno: "EPERM" })) as Win32PythonSpawn;
    const diagnosis = await runPluginPythonCheck(ctx, spawn);
    expect(diagnosis).toMatchObject({ status: "missing", transient: true });
    for (const id of ["inherited", "override"]) {
      expect(value.profiles[id]).toMatchObject({
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("demotes when every candidate is decisively not found", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const { context: ctx, value } = reconcileContext({
        profiles: { auto: win32Conpty() },
      }),
      spawn = (async () =>
        result({ code: null, errno: "ENOENT" })) as Win32PythonSpawn;
    const diagnosis = await runPluginPythonCheck(ctx, spawn);
    expect(diagnosis.status).toBe("missing");
    expect(diagnosis.transient ?? false).toBe(false);
    expect(value.profiles["auto"]).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
  });

  it("leaves stored backends alone when the launcher's interpreter is slow to confirm", async () => {
    // A py-launcher-only install whose canonical path timed out once.
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const canonical = "C:\\Users\\test\\Python312\\python.exe",
      {
        context: ctx,
        value,
        write,
      } = reconcileContext({ profiles: { auto: win32Conpty() } }),
      spawn = (async (executable) => {
        if (executable === "py") return identityResult(canonical);
        if (executable === canonical)
          return result({ code: null, timedOut: true });
        return result({ code: 9009 });
      }) as Win32PythonSpawn;
    expect(await runPluginPythonCheck(ctx, spawn)).toMatchObject({
      transient: true,
    });
    expect(value.profiles["auto"]).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses each profile's Python when global discovery fails (timeout: %s)",
    async (timedOut) => {
      vi.spyOn(console, "warn").mockImplementation(vi.fn());
      const python = "C:\\portable\\python.exe",
        { context: ctx, value } = reconcileContext({
          profiles: {
            inherited: win32Conpty(),
            working: win32Conpty({ pythonExecutable: python }),
            demoted: win32Conpty({
              pythonExecutable: "portable-shim",
              win32Backend: "legacy",
              win32BackendAutoDemoted: true,
            }),
            manual: win32Conpty({
              pythonExecutable: python,
              win32Backend: "legacy",
            }),
            slow: win32Conpty({ pythonExecutable: "slow-python" }),
          },
        }),
        spawn = vi.fn<Win32PythonSpawn>(async (executable) => {
          if (executable === python || executable === "portable-shim")
            return identityResult(python);
          return result({
            code: 9009,
            timedOut: timedOut || executable === "slow-python",
          });
        });

      await runPluginPythonCheck(ctx, spawn);

      expect(value.profiles["working"]).toMatchObject({
        pythonExecutable: python,
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
      expect(value.profiles["demoted"]).toMatchObject({
        // Re-promoted by its own value, which stays the portable name.
        pythonExecutable: "portable-shim",
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
      expect(value.profiles["manual"]).toMatchObject({
        win32Backend: "legacy",
        win32BackendAutoDemoted: false,
      });
      expect(value.profiles["inherited"]).toMatchObject({
        win32Backend: timedOut ? "conpty" : "legacy",
        win32BackendAutoDemoted: !timedOut,
      });
      expect(value.profiles["slow"]).toMatchObject({
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
    },
  );

  it.each([false, true])(
    "uses the failed override's fallback chain (available: %s)",
    async (fallbackAvailable) => {
      const python = "C:\\plugin\\python.exe",
        { context: ctx, value } = reconcileContext({
          pythonExecutable: python,
          profiles: {
            custom: win32Conpty({ pythonExecutable: "missing-python" }),
          },
        }),
        spawn = vi.fn<Win32PythonSpawn>(async (executable) =>
          executable === python ||
          (fallbackAvailable && executable === "python")
            ? identityResult(python)
            : result({ code: 9009 }),
        );

      expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
      expect(value.profiles["custom"]).toMatchObject({
        pythonExecutable: "missing-python",
        win32Backend: fallbackAvailable ? "conpty" : "legacy",
        win32BackendAutoDemoted: !fallbackAvailable,
      });
      expect(
        spawn.mock.calls.filter(
          ([executable]) => executable === "missing-python",
        ),
      ).toHaveLength(1);
    },
  );

  it("skips the settings write when the result changed nothing", async () => {
    const { context: ctx, write } = reconcileContext({
        profiles: { auto: win32Conpty() },
        pythonExecutable: "python",
      }),
      spawn = (async () => identityResult()) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps a profile's shim value and caches the interpreter it runs", async () => {
    const canonical = "C:\\Python\\pythoncore-3.14-64\\python.exe",
      {
        context: ctx,
        value,
        write,
      } = reconcileContext({
        profiles: {
          shimmed: win32Conpty({ pythonExecutable: "python" }),
        },
      }),
      spawn = vi.fn<Win32PythonSpawn>(async (executable) =>
        executable === "python" || executable === canonical
          ? identityResult(canonical, "3.14.7")
          : result({ code: 9009 }),
      );
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    // The stored value syncs and stays portable; the opener reaches the
    // interpreter through the session cache without another probe.
    expect(value.profiles["shimmed"]).toMatchObject({
      pythonExecutable: "python",
    });
    expect(value.pythonExecutable).toBe("");
    expect(write).not.toHaveBeenCalled();
    const probes = spawn.mock.calls.length;
    expect((await checkWindowsPython(ctx, "python", spawn)).executable).toBe(
      canonical,
    );
    expect(spawn.mock.calls).toHaveLength(probes);
  });

  it("uses the selected interpreter after a profile changes from venv to base", async () => {
    const venv = "C:\\venv\\Scripts\\python.exe",
      base = "C:\\Python312\\python.exe",
      profile = win32Conpty({ pythonExecutable: venv }),
      { context: ctx, value } = reconcileContext({
        profiles: { custom: profile },
      }),
      spawn = vi.fn<Win32PythonSpawn>(async (executable) => {
        if (executable === venv) return identityResult(venv, "3.12.0", base);
        if (executable === base) return identityResult(base, "3.12.0", base);
        return result({ code: 9009 });
      });
    await runPluginPythonCheck(ctx, spawn);
    const probes = spawn.mock.calls.length;
    expect(await checkWindowsPython(ctx, venv, spawn)).toMatchObject({
      executable: venv,
      hostExecutable: base,
    });
    expect(spawn.mock.calls).toHaveLength(probes);
    value.profiles["custom"] = { ...profile, pythonExecutable: base };
    expect(await checkWindowsPython(ctx, base, spawn)).toMatchObject({
      executable: base,
      hostExecutable: base,
    });
  });

  it.each<readonly [string, string, Record<string, unknown>]>([
    ["the plugin-level value", "C:\\Python312\\python.exe", {}],
    [
      "another profile's value",
      "",
      { plain: { pythonExecutable: "C:\\Python312\\python.exe" } },
    ],
  ])(
    "keeps the base interpreter's own result when it is %s",
    async (_where, pythonExecutable, profiles) => {
      vi.spyOn(console, "warn").mockImplementation(vi.fn());
      const venv = "C:\\venv\\Scripts\\python.exe",
        base = "C:\\Python312\\python.exe",
        { context: ctx } = reconcileContext({
          profiles: {
            custom: win32Conpty({ pythonExecutable: venv }),
            ...Object.fromEntries(
              Object.entries(profiles).map(([id, overrides]) => [
                id,
                win32Conpty(overrides as { pythonExecutable: string }),
              ]),
            ),
          },
          pythonExecutable,
        }),
        spawn = vi.fn<Win32PythonSpawn>(async (executable) => {
          if (executable === venv) return identityResult(venv, "3.12.0", base);
          if (executable === base) return identityResult(base, "3.12.0", base);
          return result({ code: 9009 });
        });
      await runPluginPythonCheck(ctx, spawn);
      const probes = spawn.mock.calls.length;
      // The venv's alias must not replace what the base answers for itself:
      // the resizer and the pip command would run in the wrong environment.
      expect(await checkWindowsPython(ctx, base, spawn)).toMatchObject({
        executable: base,
        hostExecutable: base,
      });
      expect(await checkWindowsPython(ctx, venv, spawn)).toMatchObject({
        executable: venv,
        hostExecutable: base,
      });
      expect(spawn.mock.calls).toHaveLength(probes);
    },
  );

  it("keeps a profile Python value when nothing resolves", async () => {
    const { context: ctx, value } = reconcileContext({
        profiles: {
          broken: win32Conpty({
            pythonExecutable: "C:\\gone\\python.exe",
          }),
        },
      }),
      spawn = (async () => result({ code: 9009 })) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).not.toBe("ok");
    expect(value.profiles["broken"]).toMatchObject({
      pythonExecutable: "C:\\gone\\python.exe",
    });
  });

  it("keeps a profile override that fails while the chain finds another Python", async () => {
    // The fallback chain's pick is not a resolution of the user's value.
    const venv = "C:\\venv\\Scripts\\python.exe",
      { context: ctx, value } = reconcileContext({
        profiles: {
          dead: win32Conpty({ pythonExecutable: venv }),
          slow: win32Conpty({ pythonExecutable: "C:\\slow\\python.exe" }),
        },
      }),
      spawn = (async (executable) => {
        if (executable === "py" || executable === "C:\\Python312\\python.exe")
          return identityResult();
        if (executable === "C:\\slow\\python.exe")
          return result({ code: null, timedOut: true });
        return result({ code: 9009 });
      }) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    expect(value.profiles["dead"]).toMatchObject({ pythonExecutable: venv });
    expect(value.profiles["slow"]).toMatchObject({
      pythonExecutable: "C:\\slow\\python.exe",
    });
  });

  it("never rewrites a profile's Python value", async () => {
    // A value shared by a Windows profile and a macOS one syncs to both; a
    // Windows path written into it would break the other platform.
    const canonical = "C:\\Python\\pythoncore-3.14-64\\python.exe",
      { context: ctx, value } = reconcileContext({
        profiles: {
          mac: win32Conpty({
            platforms: { darwin: true },
            pythonExecutable: "python",
          }),
          win: win32Conpty({ pythonExecutable: "python" }),
        },
      }),
      spawn = (async (executable) =>
        executable === "python" || executable === canonical
          ? identityResult(canonical, "3.14.7")
          : result({ code: 9009 })) as Win32PythonSpawn;
    await runPluginPythonCheck(ctx, spawn);
    expect(value.profiles["win"]).toMatchObject({ pythonExecutable: "python" });
    expect(value.profiles["mac"]).toMatchObject({ pythonExecutable: "python" });
  });

  it("keeps a user-typed value that no longer runs", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const { context: ctx, value } = reconcileContext({
        pythonExecutable: "C:\\user\\python.exe",
      }),
      spawn = (async () => result({ code: 9009 })) as Win32PythonSpawn;
    await runPluginPythonCheck(ctx, spawn);
    expect(value.pythonExecutable).toBe("C:\\user\\python.exe");
  });

  it("seeds the session cache under the configured value", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      { context: ctx, value } = reconcileContext({});
    await runPluginPythonCheck(ctx, spawn);
    const probes = spawn.mock.calls.length;
    // The opener keys its check by the configured value — empty here — so
    // the first open after discovery must not boot the interpreter again.
    expect(value.pythonExecutable).toBe("");
    await checkWindowsPython(ctx, value.pythonExecutable, spawn);
    expect(spawn.mock.calls).toHaveLength(probes);
  });

  it("probes fresh on every plugin-level check", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      { context: ctx } = reconcileContext({
        pythonExecutable: "python",
      });
    await runPluginPythonCheck(ctx, spawn);
    // A cached success would hide an uninstall.
    const probes = spawn.mock.calls.length;
    await runPluginPythonCheck(ctx, spawn);
    expect(spawn.mock.calls.length).toBeGreaterThan(probes);
  });
});
