/** Native contract coverage complements the platform-free .spec.ts suite. */
import childProcess, {
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { App } from "obsidian";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TerminalPlugin } from "../../../src/main.js";
import { Settings } from "../../../src/settings-data.js";
import {
  CONHOST_LINE_LIMIT,
  CONPTY_CONSOLE_HOST_FALLBACKS,
  CONPTY_DEPENDENCIES,
  ConPtyHostPool,
  ConPtyPseudoterminal,
  type ConPtyPseudoterminalDependencies,
  type ConPtyResizedEvent,
  type ConPtySpareHost,
  WindowsNamedPipeControlChannel,
  WindowsPseudoterminal,
  conPtyConsoleHostSpec,
} from "../../../src/terminal/pseudoterminal.js";
import { writePromise } from "../../../src/utils.js";

// Only the Obsidian UI context is replaced. All protocol, environment,
// materialization, pool, and process behavior comes from shipped code.
vi.mock("../../../src/main.js", () => ({
  TerminalPlugin: class {
    // A ConPTY terminal registers its quit hook here.
    public readonly app = {
      workspace: { offref: vi.fn(), on: vi.fn(() => ({})) },
    };

    public readonly register = vi.fn();
    public readonly language = { value: { t: vi.fn((key: string) => key) } };
    public readonly settings = {
      // Each test explicitly owns its spare; no automatic refill races cleanup.
      // `nativeFixture` replaces this with the settings of its run.
      value: { errorNoticeTimeout: 0, prewarmConPty: false },
    };
  },
}));

const TIMEOUT_MS = 15_000,
  BARRIER = "TES166_INPUT_BARRIER",
  COMMAND = [
    "cmd.exe",
    "/d",
    "/q",
    "/c",
    `set /p gate=${BARRIER} & echo hi & exit 3`,
  ],
  TOKEN_ENV = "OBSIDIAN_TERMINAL_CONPTY_TOKEN";

interface WireRecord {
  readonly [key: string]: unknown;
}
interface RecordedConnection {
  readonly socket: Socket;
  readonly events: () => readonly WireRecord[];
  readonly operations: () => readonly WireRecord[];
}
interface RecordedChannel {
  readonly control: WindowsNamedPipeControlChannel;
  readonly server: Server;
  readonly closed: Promise<void>;
  readonly connections: readonly RecordedConnection[];
}
interface RecordedHost {
  readonly host: ChildProcessWithoutNullStreams;
  readonly args: readonly string[];
  readonly token: string | undefined;
  readonly output: () => string;
  readonly closed: Promise<void>;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`Timed out: ${label}`));
        }, TIMEOUT_MS);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

/** Decode the captured bytes independently of parseConPtyHostEvent. */
function wireRecords(chunks: readonly Buffer[]): readonly WireRecord[] {
  const text = Buffer.concat(chunks).toString("utf8");
  expect(text === "" || text.endsWith("\n")).toBe(true);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      if (
        typeof record !== "object" ||
        record === null ||
        Array.isArray(record)
      ) {
        throw new Error("Expected a wire object");
      }
      return Object.fromEntries(Object.entries(record));
    });
}

/** Observe the actual accepted socket, leaving its reads and writes intact. */
async function recordedChannel(deferred: boolean): Promise<RecordedChannel> {
  const server = createServer(),
    closed = new Promise<void>((resolve) => {
      server.once("close", () => {
        resolve();
      });
    }),
    connections: RecordedConnection[] = [];
  server.on("connection", (socket) => {
    const chunks: Buffer[] = [],
      writes = vi.spyOn(socket, "write"); // Calls through to the real pipe.
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    connections.push({
      socket,
      events: () => wireRecords(chunks),
      operations: () =>
        wireRecords(
          writes.mock.calls.map(([chunk]) => {
            const value: unknown = chunk;
            if (typeof value === "string" || value instanceof Uint8Array)
              return Buffer.from(value);
            throw new Error("Unexpected control-pipe write");
          }),
        ),
    });
  });
  const control = await WindowsNamedPipeControlChannel.create({
    createServer: () => server,
    randomUUID,
    deferred,
  });
  return { control, server, closed, connections };
}

function loadHostSource(): Promise<string> {
  // Vite's happy-dom client environment rewrites .py imports and
  // new URL(<literal>, import.meta.url) to asset URLs. Read the same bytes
  // production embeds via a filesystem path to avoid that rewrite.
  return readFile(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../src/terminal/win32_conpty.py",
    ),
    "utf8",
  );
}

/**
 * The plugin settings of a run: the shipped defaults, which ask for Windows
 * Terminal's console host, or those with that setting off. Prewarming stays
 * off: each test explicitly owns its spare, so no refill races cleanup.
 */
function contractSettings(consoleHost: "default" | "off"): Settings {
  return Settings.fix({
    errorNoticeTimeout: 0,
    prewarmConPty: false,
    ...(consoleHost === "off" ? { windowsTerminalConsoleHost: false } : {}),
  }).value;
}

/** Isolated real pool with ownership tracking, reusable for spare lifecycle tests. */
async function nativeFixture(
  python: string,
  settings: Settings = contractSettings("default"),
) {
  const source = await loadHostSource(),
    pool = new ConPtyHostPool(),
    channels: RecordedChannel[] = [],
    hosts: RecordedHost[] = [],
    pending = new Set<Promise<unknown>>(),
    context = new TerminalPlugin(new App(), {
      id: "conpty-contract",
      name: "ConPTY contract",
      author: "test",
      description: "Native protocol test",
      version: "0.0.0",
      minAppVersion: "1.4.11",
    });
  Object.assign(context.settings, { value: settings });
  // Mutation is confined to this fixture's lifecycle and resource ledger.
  let closing = false;
  const track = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (closing) throw new Error("The native fixture is closing");
      const promise = operation();
      pending.add(promise);
      try {
        return await promise;
      } finally {
        pending.delete(promise);
      }
    },
    createControl = async (
      deferred: boolean,
    ): Promise<WindowsNamedPipeControlChannel> =>
      track(async () => {
        const recorded = await recordedChannel(deferred);
        channels.push(recorded);
        if (closing) {
          await recorded.control.dispose();
          throw new Error("Channel created during fixture cleanup");
        }
        return recorded.control;
      }),
    dependencies: ConPtyPseudoterminalDependencies = {
      ...CONPTY_DEPENDENCIES,
      pool,
      source: Promise.resolve(source),
      createControl: async () => createControl(false),
      createDeferredControl: async () => createControl(true),
      spawn: async (executable, args, options) =>
        track(async () => {
          const host = await CONPTY_DEPENDENCIES.spawn(
              executable,
              args,
              options,
            ),
            chunks: Buffer[] = [],
            closed = new Promise<void>((resolve) =>
              host.once("close", () => {
                resolve();
              }),
            );
          host.stdout.on("data", (chunk: Buffer) =>
            chunks.push(Buffer.from(chunk)),
          );
          hosts.push({
            host,
            args,
            token: options.env[TOKEN_ENV],
            output: () => Buffer.concat(chunks).toString("utf8"),
            closed,
          });
          if (closing) {
            host.kill();
            throw new Error("Host spawned during fixture cleanup");
          }
          return host;
        }),
    };
  return {
    pool,
    channels,
    hosts,
    dependencies,
    open: () =>
      new ConPtyPseudoterminal(
        context,
        {
          executable: COMMAND[0] ?? "cmd.exe",
          args: COMMAND.slice(1),
          pythonExecutable: python,
          columns: 80,
          rows: 24,
          environment: [["TES166_CONTRACT", "字"]],
        },
        dependencies,
      ),
    async spare(): Promise<ConPtySpareHost> {
      // With the console host hint the plugin's own refills pass.
      pool.ensureSpare(python, dependencies, conPtyConsoleHostSpec(settings));
      // Use the public ownership transfer to wait until the pool can serve it.
      return vi.waitFor(
        () => {
          const spare = pool.acquire(python);
          if (!spare) throw new Error("Waiting for an authenticated spare");
          pool.release(python, spare);
          return spare;
        },
        { timeout: TIMEOUT_MS },
      );
    },
    async cleanup(): Promise<void> {
      closing = true;
      pool.dispose();
      // A boot already in flight may finish during disposal. The wrappers
      // record it before resolving; further creates/spawns are then refused.
      try {
        await bounded(Promise.allSettled([...pending]), "pending fixture work");
      } finally {
        for (const { host } of hosts) {
          if (host.exitCode === null && host.signalCode === null) host.kill();
        }
        for (const { connections } of channels) {
          for (const { socket } of connections) socket.destroy();
        }
        const results = await Promise.allSettled([
          ...channels.map(({ control }) =>
            bounded(control.dispose(), "pipe disposal"),
          ),
          ...channels.map(({ closed }) => bounded(closed, "server close")),
          ...hosts.map(({ closed }) => bounded(closed, "host close")),
        ]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual(
          [],
        );
        expect(
          channels.every(
            ({ server, connections }) =>
              !server.listening &&
              connections.every(({ socket }) => socket.destroyed),
          ),
        ).toBe(true);
        expect(
          hosts.every(
            ({ host }) => host.exitCode !== null || host.signalCode !== null,
          ),
        ).toBe(true);
      }
    },
  };
}

function connection(channel: RecordedChannel): RecordedConnection {
  expect(channel.connections).toHaveLength(1);
  const wire = channel.connections[0];
  if (!wire) throw new Error("No recorded connection");
  return wire;
}

function only<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  const value = values[0];
  if (!value) throw new Error("Expected one owned resource");
  return value;
}

// Typed `unknown`: the matchers are `any`, which the lint rules refuse.
const OPENCONSOLE_PATH: unknown = expect.stringMatching(/OpenConsole\.exe$/iu),
  FALLBACK: unknown = expect.toBeOneOf([...CONPTY_CONSOLE_HOST_FALLBACKS]),
  FALLBACK_DETAIL: unknown = expect.toBeOneOf([null, expect.any(String)]),
  /**
   * The `consoleHost` report of a session that asked for Windows Terminal's
   * console host: it runs, or the built-in one runs and says why. Which one
   * depends on whether Windows Terminal 1.22 or newer is installed.
   */
  REQUESTED_CONSOLE_HOST: unknown = expect.toBeOneOf([
    {
      engine: "openconsole",
      path: OPENCONSOLE_PATH,
      fallback: null,
      detail: null,
    },
    {
      engine: "conhost",
      path: null,
      fallback: FALLBACK,
      detail: FALLBACK_DETAIL,
    },
  ]);

async function assertReady(
  channel: RecordedChannel,
  spawned: RecordedHost,
  warm: boolean,
  settings: Settings = contractSettings("default"),
): Promise<void> {
  const consoleHost = conPtyConsoleHostSpec(settings),
    { control } = channel,
    hello = await bounded(control.hello, "hello"),
    ready = await bounded(control.ready, "authenticated ready"),
    wire = connection(channel),
    expectedHello = {
      event: "hello",
      token: control.token,
      hostPid: spawned.host.pid,
      childPid: hello.childPid,
    },
    expectedReady = {
      event: "ready",
      attestation:
        "create-pseudoconsole+authenticated-control-channel+job-object-assigned",
      hostPid: spawned.host.pid,
      childPid: hello.childPid,
      consoleHost:
        consoleHost === null
          ? { engine: "conhost", path: null, fallback: null, detail: null }
          : REQUESTED_CONSOLE_HOST,
      controlChannelAuthenticated: true,
      createPseudoConsole: true,
      jobObjectAssigned: true,
    };
  expect(spawned.token).toBe(control.token);
  expect(spawned.args).toContain(control.path);
  expect(hello.childPid).toBeGreaterThan(0);
  expect(hello.childPid).not.toBe(spawned.host.pid);
  expect(hello).toEqual(expectedHello);
  expect(ready).toEqual(expectedReady);
  expect(wire.events()).toEqual([
    ...(warm
      ? [{ event: "idle", token: control.token, hostPid: spawned.host.pid }]
      : []),
    expectedHello,
    expectedReady,
  ]);
  expect(wire.operations()[0]).toEqual({
    op: "authenticate",
    token: control.token,
  });
  if (warm) {
    expect(spawned.args).toContain("--defer-session");
    const start = wire.operations()[1];
    expect(Object.keys(start ?? {}).sort()).toEqual([
      "columns",
      "command",
      ...(consoleHost === null ? [] : ["consoleHost"]),
      "cwd",
      "env",
      "op",
      "rows",
    ]);
    expect(start).toMatchObject({
      op: "start",
      columns: 80,
      rows: 24,
      command: COMMAND,
      cwd: null,
    });
    expect(start?.consoleHost).toBe(consoleHost ?? undefined);
    expect(start?.env).toHaveProperty("TES166_CONTRACT", "字");
  } else {
    expect(spawned.args.slice(-COMMAND.length)).toEqual(COMMAND);
    expect(spawned.args).not.toContain("--defer-session");
  }
  if (consoleHost === null) {
    // Neither path names a console host, as before the setting existed.
    expect(spawned.args).not.toContain("--console-host");
  } else {
    // The cold host gets it before the command; the spare, as a hint, last.
    expect(
      warm
        ? spawned.args.slice(-2)
        : spawned.args.slice(-COMMAND.length - 3, -COMMAND.length),
    ).toEqual(["--console-host", consoleHost, ...(warm ? [] : ["--"])]);
  }
}

// The fixture's source loading must work in Vitest even off Windows.
it("loads the real Python host source in the test environment", async () => {
  expect((await loadHostSource()).length).toBeGreaterThan(0);
});

// The default runs below ask for Windows Terminal's console host, as shipped.
it("runs the contract on the shipped default and with the console host off", () => {
  expect(conPtyConsoleHostSpec(contractSettings("default"))).toBe("auto");
  expect(conPtyConsoleHostSpec(contractSettings("off"))).toBeNull();
});

const CONHOST_TIMEOUT_MS = 20_000,
  CONHOST_CMD = "C:\\Windows\\System32\\cmd.exe",
  CONHOST_HOSTNAME = "C:\\Windows\\System32\\HOSTNAME.EXE",
  CONHOST_POWERSHELL =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  CONHOST_PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  CONHOST_HOST_SOURCE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../src/terminal/win32_conpty.py",
  ),
  /*
   * Records what the program received, the command line Windows gave it and
   * the command line the ConPTY host builds for the same arguments. The last
   * comes from `build_command_line` in the shipped `win32_conpty.py`, so the
   * expected text never comes from the TypeScript under test.
   */
  CONHOST_PROBE_PY = [
    "import ctypes, json, os, sys",
    "from importlib.util import module_from_spec, spec_from_file_location",
    "kernel32 = ctypes.windll.kernel32",
    "kernel32.GetCommandLineW.restype = ctypes.c_wchar_p",
    "spec = spec_from_file_location('conpty_host', os.environ['PROBE_HOST'])",
    "host = module_from_spec(spec)",
    "spec.loader.exec_module(host)",
    "with open(os.environ['PROBE_EXPECT'], encoding='utf-8') as source:",
    "    expected = host.build_command_line(json.load(source))",
    "with open(os.environ['PROBE_OUT'], 'w', encoding='utf-8') as out:",
    "    json.dump({",
    "        'argv': sys.argv[1:],",
    "        'expected': expected,",
    "        'leaked': sorted(",
    "            name for name in os.environ",
    "            if name.upper() == 'Q'",
    "            or name.upper().startswith('OBSIDIAN_TERMINAL_CONHOST')",
    "        ),",
    "        'line': kernel32.GetCommandLineW(),",
    "    }, out)",
    "sys.exit(int(os.environ.get('PROBE_CODE', '0')))",
    "",
  ].join("\r\n"),
  // Raises Ctrl+C inside conhost's own console, survives it and exits 7.
  CONHOST_CTRL_C_PY = [
    "import ctypes, signal, sys, time",
    "signal.signal(signal.SIGINT, lambda *_: None)",
    "for _ in range(int(sys.argv[1])):",
    "    ctypes.windll.kernel32.GenerateConsoleCtrlEvent(0, 0)",
    "    time.sleep(1)",
    "sys.exit(7)",
    "",
  ].join("\r\n"),
  CONHOST_PYTHON_CASES: readonly (readonly [string, readonly string[]])[] = [
    ["plain", ["plain"]],
    ["space", ["two words"]],
    ["switches", ["/d", "/k", "-c"]],
    ["caret", ["a^b"]],
    ["caret and bang", ["a^b!"]],
    ["percent", ["100%", "%PATH%", "%%", "%~dp0"]],
    ["cmd specials", ["a&b|c<d>e(f)g"]],
    ["specials with spaces", ["a & b | c > d"]],
    ["quotes", ['say "hi"']],
    ["trailing backslash", ["C:\\dir\\", "next"]],
    ["trailing backslash with space", ["C:\\Program Files\\", "next"]],
    ["backslash before quote", ['a\\"b', 'c\\\\"d']],
    ["empty", ["", "x"]],
    ["bang", ["wow!", "!PATH!"]],
    ["expansion lookalikes", ["!q!", "!ERRORLEVEL!", "%q%"]],
    [
      "the launch variable names",
      [
        "%OBSIDIAN_TERMINAL_CONHOST_ARGUMENTS%",
        "!OBSIDIAN_TERMINAL_CONHOST_PROGRAM!",
      ],
    ],
    ["unbalanced quote", ['"', "x"]],
    ["quotes around specials", ['a"&"b', "c^d"]],
    ["caret at end", ["end^"]],
    ["double space", ["a  b"]],
    ["tab", ["a\tb"]],
    ["delimiters", ["a=b,c;d"]],
    ["apostrophe and backquote", ["it's `x`"]],
    ["non-ASCII", ["J\u00fcrgen", "\u65e5\u672c\u8a9e", "\u{1f600}"]],
    ["Ctrl+Z", ["a\u001ab"]],
    ["mixed", ["C:\\Program Files\\x y\\", "-c", 'print("a & b")', "100% ^!"]],
  ];

interface ConHostRun {
  readonly code: Awaited<WindowsPseudoterminal["onExit"]> | "timeout";
  readonly output: string;
}

interface ConHostProbe {
  readonly argv: readonly string[];
  readonly expected: string;
  readonly leaked: readonly string[];
  readonly line: string;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

/** What the probe program wrote, or `false` for any other JSON. */
function isConHostProbe(value: unknown): value is ConHostProbe {
  return (
    typeof value === "object" &&
    value !== null &&
    "argv" in value &&
    isStringArray(value.argv) &&
    "expected" in value &&
    typeof value.expected === "string" &&
    "leaked" in value &&
    isStringArray(value.leaked) &&
    "line" in value &&
    typeof value.line === "string"
  );
}

/** Sets `TEMP` and `TMP` for `body`, then puts them back as they were. */
async function withTemporaryFolder<T>(
  folder: string,
  body: () => Promise<T>,
): Promise<T> {
  const { TEMP, TMP } = process.env;
  process.env.TEMP = folder;
  process.env.TMP = folder;
  try {
    return await body();
  } finally {
    if (TEMP === undefined) delete process.env.TEMP;
    else process.env.TEMP = TEMP;
    if (TMP === undefined) delete process.env.TMP;
    else process.env.TMP = TMP;
  }
}

function conhostContext(): TerminalPlugin {
  return new TerminalPlugin(new App(), {
    id: "conhost-command-line",
    name: "ConHost command line",
    author: "test",
    description: "Native ConHost test",
    version: "0.0.0",
    minAppVersion: "1.4.11",
  });
}

/**
 * Opens a resizer-less ConHost terminal through the shipped
 * `WindowsPseudoterminal` and real `conhost.exe`. `input` is written to the
 * console once the shell shows a prompt, as typed keys are.
 */
async function runConHost(
  executable: string,
  args: readonly string[],
  {
    cwd,
    environment = [],
    input,
  }: {
    readonly cwd?: string;
    readonly environment?: readonly (readonly [string, string])[];
    readonly input?: string;
  } = {},
): Promise<ConHostRun> {
  const pty = new WindowsPseudoterminal(conhostContext(), {
      args,
      cwd,
      environment,
      executable,
    }),
    shell = await bounded(pty.shell, "ConHost spawn"),
    chunks: Buffer[] = [],
    output = (): string =>
      stripVTControlCharacters(Buffer.concat(chunks).toString("utf8"));
  shell.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  shell.stderr.resume();
  if (input !== undefined) {
    await vi
      .waitFor(
        () => {
          expect(output()).toContain(">");
        },
        { timeout: CONHOST_TIMEOUT_MS / 2 },
      )
      .catch(() => {
        // Type anyway: the exit code then shows what the shell did.
      });
    await writePromise(shell.stdin, input);
  }
  let timer: number | undefined;
  try {
    const code = await Promise.race([
      pty.onExit,
      new Promise<"timeout">((resolve) => {
        timer = window.setTimeout(() => {
          shell.kill();
          resolve("timeout");
        }, CONHOST_TIMEOUT_MS);
      }),
    ]);
    return { code, output: output() };
  } finally {
    window.clearTimeout(timer);
  }
}

/** The error a ConHost open fails with, or `"spawned"` after killing it. */
async function conhostRefusal(
  executable: string,
  args: readonly string[],
): Promise<string> {
  const pty = new WindowsPseudoterminal(conhostContext(), {
    args,
    executable,
  });
  pty.onExit.catch(() => {
    // Asserted through `shell`.
  });
  return pty.shell.then(
    (shell) => {
      shell.kill();
      return "spawned";
    },
    (error: unknown) => String(error),
  );
}

// Explicit off-Windows skips are intentional: only real cmd.exe and
// conhost.exe show how the batch line is parsed.
describe.skipIf(process.platform !== "win32")(
  "real ConHost command line",
  () => {
    let python = "",
      probePy = "",
      work = "";

    beforeAll(async () => {
      const result = await promisify(execFile)(
        "python",
        [
          "-I",
          "-c",
          "import sys; print(getattr(sys, '_base_executable', sys.executable))",
        ],
        { timeout: TIMEOUT_MS },
      );
      python = result.stdout.trim();
      expect(win32.isAbsolute(python)).toBe(true);
      work = await mkdtemp(win32.join(tmpdir(), "conhost-command-line-"));
      probePy = win32.join(work, "probe.py");
      await writeFile(probePy, CONHOST_PROBE_PY, "utf8");
      await writeFile(win32.join(work, "ctrl_c.py"), CONHOST_CTRL_C_PY, "utf8");
      await writeFile(win32.join(work, "nine.cmd"), "@exit /b 9\r\n", "utf8");
    }, TIMEOUT_MS + 1000);

    /** Runs the probe with `args` and reads what it recorded. */
    async function probe(
      args: readonly string[],
      {
        code = 0,
        cwd,
        environment = [],
      }: {
        readonly code?: number;
        readonly cwd?: string;
        readonly environment?: readonly (readonly [string, string])[];
      } = {},
    ): Promise<ConHostRun & { readonly probe: ConHostProbe | null }> {
      const dir = await mkdtemp(win32.join(work, "p-")),
        out = win32.join(dir, "probe.json"),
        expected = win32.join(dir, "expected.json");
      await writeFile(expected, JSON.stringify([probePy, ...args]), "utf8");
      const run = await runConHost(python, [probePy, ...args], {
        cwd,
        environment: [
          ["PROBE_CODE", String(code)],
          ["PROBE_EXPECT", expected],
          ["PROBE_HOST", CONHOST_HOST_SOURCE],
          ["PROBE_OUT", out],
          ...environment,
        ],
      });
      let recorded: unknown = null;
      try {
        recorded = JSON.parse(await readFile(out, "utf8"));
      } catch {
        // The program did not start or did not finish.
      }
      return { ...run, probe: isConHostProbe(recorded) ? recorded : null };
    }

    it.each<readonly [string, readonly string[], number]>([
      ["a quoted command", ["/d", "/c", "prompt CMD$G$S"], 0],
      ["exit in quotes", ["/d", "/c", "exit 3"], 3],
      ["a chained command", ["/d", "/c", "echo a & exit 4"], 4],
      ["split arguments", ["/d", "/c", "exit", "5"], 5],
      ["a percent variable", ["/d", "/c", "if %OS%==Windows_NT exit 6"], 6],
    ])(
      "lets cmd run %s after /c",
      async (_label, args, expected) => {
        await expect(runConHost(CONHOST_CMD, args)).resolves.toMatchObject({
          code: expected,
        });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "starts cmd with the quoted /k prompt of the profile",
      async () => {
        const run = await runConHost(
          CONHOST_CMD,
          ["/d", "/k", "prompt CMD$G$S"],
          { input: 'if "%PROMPT%"=="CMD$G$S" (exit 11) else exit 12\r' },
        );
        expect(run.output).not.toContain("is not recognized");
        expect(run.code).toBe(11);
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "starts cmd without arguments",
      async () => {
        await expect(
          runConHost(CONHOST_CMD, [], { input: "exit 13\r" }),
        ).resolves.toMatchObject({ code: 13 });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it.each(CONHOST_PYTHON_CASES)(
      "passes %s to a program as ConPTY does",
      async (_label, args) => {
        const run = await probe(args),
          program = `"${python}"`;
        expect(run.code).toBe(0);
        expect(run.probe?.argv).toEqual(args);
        expect(run.probe?.line.startsWith(program)).toBe(true);
        // cmd puts its own spaces after the quoted program name.
        expect(run.probe?.line.slice(program.length).trimStart()).toBe(
          run.probe?.expected,
        );
        expect(run.probe?.leaked).toEqual([]);
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "keeps its own launch variables when the profile sets them in lower case",
      async () => {
        const args = ["a b", "c^d"],
          run = await probe(args, {
            environment: [
              ["obsidian_terminal_conhost_arguments", "--version"],
              ["obsidian_terminal_conhost_program", CONHOST_HOSTNAME],
            ],
          });
        expect(run.code).toBe(0);
        expect(run.probe?.argv).toEqual(args);
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "refuses a line break before conhost starts",
      async () => {
        await expect(
          conhostRefusal(CONHOST_CMD, ["/d", "/c", "echo line1\nexit 9"]),
        ).resolves.toContain("errors.conhost-cannot-pass");
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it.each<readonly [string, string, readonly string[], number]>([
      ["a caret", CONHOST_POWERSHELL, ["-Command", "exit ('a^b'.Length)"], 3],
      [
        "an ampersand",
        CONHOST_POWERSHELL,
        ["-Command", "exit ('a & b'.Length)"],
        5,
      ],
      [
        "double quotes",
        CONHOST_POWERSHELL,
        ["-Command", 'exit ("abc".Length + 6)'],
        9,
      ],
      ["a Program Files path", CONHOST_PWSH, ["-Command", "exit 10"], 10],
    ])(
      "lets PowerShell run %s",
      async (_label, executable, args, expected) => {
        try {
          await access(executable);
        } catch {
          // pwsh is optional on the runner image.
          return;
        }
        await expect(
          runConHost(executable, [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            ...args,
          ]),
        ).resolves.toMatchObject({ code: expected });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it.each(["a^b", "a b & c", "100% x", "wow!", "J\u00fcrgen", "(x) y"])(
      "starts a program in folder %s",
      async (folder) => {
        const dir = win32.join(work, "exe", folder),
          executable = win32.join(dir, "HOSTNAME.EXE");
        await mkdir(dir, { recursive: true });
        await copyFile(CONHOST_HOSTNAME, executable);
        await expect(runConHost(executable, [])).resolves.toMatchObject({
          code: 0,
        });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it.each(["e^x y", "e!x", "e&x y", "e%x", "J\u00fcrgen"])(
      "reports the exit code from a temporary folder %s",
      async (folder) => {
        const temp = win32.join(work, "temp", folder);
        await mkdir(temp, { recursive: true });
        // The batch file, which also holds the exit code, goes to TEMP.
        const run = await withTemporaryFolder(temp, async () =>
          probe([], { code: 12 }),
        );
        expect(run.probe?.argv).toEqual([]);
        expect(run.code).toBe(12);
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    // Windows starts the batch file through cmd, which takes `^`, `&` and
    // parentheses in an unquoted path as syntax. A user name may hold them.
    it.each(["e^x", "a&b", "(x)", "a^b&c(d)"])(
      "starts the program from a temporary folder %s",
      async (folder) => {
        const temp = win32.join(work, "temp", folder);
        await mkdir(temp, { recursive: true });
        const run = await withTemporaryFolder(temp, async () => probe(["x"]));
        expect({ argv: run.probe?.argv, code: run.code }).toEqual({
          argv: ["x"],
          code: 0,
        });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it.each([1, 2])(
      "reports the exit code without a batch prompt after %i Ctrl+C",
      async (events) => {
        const run = await runConHost(python, [
          win32.join(work, "ctrl_c.py"),
          String(events),
        ]);
        expect(run.output).not.toMatch(/Terminate batch job/iu);
        expect(run.code).toBe(7);
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "reports the exit code of a .cmd program",
      async () => {
        await expect(
          runConHost(win32.join(work, "nine.cmd"), []),
        ).resolves.toMatchObject({ code: 9 });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "records the exit code without running an echo.cmd",
      async () => {
        const trap = await mkdtemp(win32.join(work, "echo-")),
          marker = win32.join(trap, "marker.txt");
        await writeFile(
          win32.join(trap, "echo.cmd"),
          `@type nul > "${marker}"\r\n@exit /b 0\r\n`,
          "utf8",
        );
        const run = await probe([], {
          code: 12,
          cwd: trap,
          environment: [["PATH", `${trap};${process.env.PATH ?? ""}`]],
        });
        expect(run.code).toBe(12);
        await expect(access(marker)).rejects.toThrow();
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "starts the longest command it accepts intact and refuses one more character",
      async () => {
        // A refusal depends only on lengths, and every temporary file of
        // this process has a path of the same length, so the largest
        // accepted length is found by search. The surrogate pair counts two.
        const argument = (length: number): string =>
            `\u{1f600}${"x".repeat(length)}`,
          accepted = async (length: number): Promise<boolean> => {
            const outcome = await conhostRefusal(python, [
              probePy,
              argument(length),
            ]);
            if (outcome === "spawned") return true;
            expect(outcome).toContain("errors.conhost-cannot-pass");
            return false;
          };
        let low = 0,
          high = CONHOST_LINE_LIMIT;
        expect(await accepted(low)).toBe(true);
        expect(await accepted(high)).toBe(false);
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (await accepted(middle)) low = middle;
          else high = middle;
        }
        const args = [argument(low)],
          run = await probe(args),
          program = `"${python}"`;
        expect(run.code).toBe(0);
        expect(run.probe?.argv).toEqual(args);
        expect(run.probe?.line.slice(program.length).trimStart()).toBe(
          run.probe?.expected,
        );
      },
      CONHOST_TIMEOUT_MS * 6,
    );

    /** Asserts that the probe got `args` as the ConPTY host passes them. */
    function expectConPtyParity(
      run: ConHostRun & { readonly probe: ConHostProbe | null },
      args: readonly string[],
    ): void {
      const program = `"${python}"`;
      expect(run.code).toBe(0);
      expect(run.probe?.argv).toEqual(args);
      expect(run.probe?.line.startsWith(program)).toBe(true);
      expect(run.probe?.line.slice(program.length).trimStart()).toBe(
        run.probe?.expected,
      );
      expect(run.probe?.leaked).toEqual([]);
    }

    /**
     * Runs `body` with a value of cmd's own registry key set for the user,
     * then puts the key back as it was.
     */
    async function withCommandProcessorValue(
      name: string,
      type: string,
      data: string,
      body: () => Promise<void>,
    ): Promise<void> {
      const key = "HKCU\\Software\\Microsoft\\Command Processor",
        reg = async (args: readonly string[]): Promise<string> =>
          (await promisify(execFile)("reg", args, { timeout: TIMEOUT_MS }))
            .stdout,
        before = await reg(["query", key, "/v", name]).then(
          (stdout) =>
            new RegExp(`^\\s*${name}\\s+(REG_\\w+)\\s+(.*?)\\s*$`, "imu").exec(
              stdout,
            ),
          () => null,
        );
      await reg(["add", key, "/v", name, "/t", type, "/d", data, "/f"]);
      try {
        await body();
      } finally {
        await (before === null
          ? reg(["delete", key, "/v", name, "/f"])
          : reg([
              "add",
              key,
              "/v",
              name,
              "/t",
              before[1] ?? type,
              "/d",
              before[2] ?? "",
              "/f",
            ]));
      }
    }

    it.each<readonly [string, readonly string[]]>([
      ["a leading comma", [",x"]],
      ["a leading semicolon", [";x"]],
      ["a leading equals sign", ["=x", "="]],
      ["a form feed", ["\f", "a\fb"]],
      ["a y with diaeresis", ["\u00ffx"]],
      ["a no-break space", ["\u00a0x"]],
      ["an at sign", ["@x"]],
      ["label lookalikes", ["::x", ":x"]],
      ["a help switch", ["/?"]],
      ["redirection lookalikes", ["2>nul", ">x", "<y", "1>&2", "|"]],
      ["single specials", ["^", "%", "!", "(", ")", "&"]],
    ])(
      "passes %s at the start of the arguments as ConPTY does",
      async (_label, args) => {
        expectConPtyParity(await probe(args), args);
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "passes carets and bangs when the registry turns delayed expansion on",
      async () => {
        await withCommandProcessorValue(
          "DelayedExpansion",
          "REG_DWORD",
          "1",
          async () => {
            const args = ["a^b!", "!PATH!", "wow!", "%PATH%"];
            expectConPtyParity(await probe(args), args);
          },
        );
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it.each<readonly [string, string, readonly string[], number]>([
      ["cmd.exe", "cmd.exe", ["/d", "/c", "exit 3"], 3],
      [
        "powershell",
        "powershell",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 4"],
        4,
      ],
      [
        "PowerShell with a dollar sign and a backtick",
        CONHOST_POWERSHELL,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "exit ('a$b`c'.Length)",
        ],
        5,
      ],
    ])(
      "starts %s by the name a preset uses",
      async (_label, executable, args, expected) => {
        await expect(runConHost(executable, args)).resolves.toMatchObject({
          code: expected,
        });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "starts the PowerShell preset without arguments",
      async () => {
        await expect(
          runConHost("powershell", [], { input: "exit 22\r" }),
        ).resolves.toMatchObject({ code: 22 });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it.each<readonly [string, readonly string[], number]>([
      ["the Git Bash preset", ["--login", "-c", "exit 14"], 14],
      [
        "arguments through Git Bash",
        ["-c", "exit $(( $# * 10 + ${#1} ))", "_", "a b^c"],
        15,
      ],
    ])(
      "starts %s",
      async (_label, args, expected) => {
        const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
        try {
          await access(bash);
        } catch {
          // Git for Windows is optional on the runner image.
          return;
        }
        await expect(runConHost(bash, args)).resolves.toMatchObject({
          code: expected,
        });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    it(
      "starts in a working folder with cmd specials",
      async () => {
        const cwd = win32.join(work, "c&d^e%f!g (h) J\u00fcrgen");
        await mkdir(cwd, { recursive: true });
        await expect(
          runConHost(
            python,
            [
              "-c",
              "import os, sys; sys.exit(15 if os.getcwd() == sys.argv[1] else 16)",
              cwd,
            ],
            { cwd },
          ),
        ).resolves.toMatchObject({ code: 15 });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    // A file named echo.cmd or echo.bat in the terminal's working folder, such
    // as a vault root, or on PATH must not run when the program exits.
    it.each([
      ["echo.cmd", "the working folder"],
      ["echo.bat", "the working folder"],
      ["echo.cmd", "PATH"],
    ])(
      "records the exit code without running a file named %s in %s",
      async (name, where) => {
        const trap = await mkdtemp(win32.join(work, "echo-")),
          marker = win32.join(trap, "marker.txt");
        await writeFile(
          win32.join(trap, name),
          `@type nul > "${marker}"\r\n@exit /b 0\r\n`,
          "utf8",
        );
        const run = await probe(
            [],
            where === "PATH"
              ? {
                  code: 12,
                  environment: [["PATH", `${trap};${process.env.PATH ?? ""}`]],
                }
              : { code: 12, cwd: trap },
          ),
          ran = await access(marker).then(
            () => true,
            () => false,
          );
        expect({ code: run.code, ran }).toEqual({ code: 12, ran: false });
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    // cmd expands a variable named ERRORLEVEL instead of the exit code.
    it(
      "reports the program's exit code when the profile sets ERRORLEVEL",
      async () => {
        const run = await probe([], {
          code: 3,
          environment: [["ERRORLEVEL", "42"]],
        });
        expect(run.probe?.argv).toEqual([]);
        expect(run.code).toBe(3);
      },
      CONHOST_TIMEOUT_MS * 2,
    );

    // Node hands the environment to Windows as UTF-8, so a lone surrogate,
    // which only a hand-edited profile can hold, arrives as U+FFFD. ConPTY,
    // which sends the command as JSON, keeps it.
    it(
      "passes a lone surrogate as U+FFFD",
      async () => {
        const run = await probe(["a\ud800b"]);
        expect(run.code).toBe(0);
        expect(run.probe?.argv).toEqual(["a\ufffdb"]);
        expect(run.probe?.leaked).toEqual([]);
      },
      CONHOST_TIMEOUT_MS * 2,
    );
  },
);

// Explicit off-Windows skips are intentional: mocks cannot establish this contract.
/** A shell that leaves a ping in a hidden console, prints its PID and waits. */
const HIDDEN_HELPER_SHELL = [
  "import os, subprocess, time",
  "ping = os.path.join(os.environ['SystemRoot'], 'System32', 'PING.EXE')",
  "helper = subprocess.Popen(",
  "    [ping, '-n', '300', '127.0.0.1'],",
  "    stdin=subprocess.DEVNULL,",
  "    stdout=subprocess.DEVNULL,",
  "    stderr=subprocess.DEVNULL,",
  "    creationflags=subprocess.CREATE_NO_WINDOW,",
  ")",
  "print(f'HELPER-PID {helper.pid}', flush=True)",
  "time.sleep(60)",
].join("\n");

/** A shell that waits for Ctrl+C and says when it came. */
const CTRL_C_SHELL = [
  "import time",
  "print('WAITING-FOR-CTRL-C', flush=True)",
  "try:",
  "    time.sleep(60)",
  "except KeyboardInterrupt:",
  "    print('INTERRUPTED', flush=True)",
].join("\n");

/**
 * A parent for the host in Obsidian's place: it spawns the host as it is
 * told, prints the host's PID, passes the host's output on and runs until it
 * is killed, as Obsidian's window process can go before the host is done.
 */
const HOST_PARENT = [
  "const { spawn } = require('node:child_process');",
  "const [executable, args, options] = process.argv.slice(1);",
  "const host = spawn(executable, JSON.parse(args), JSON.parse(options));",
  "host.once('spawn', () => process.stdout.write('HOST-PID ' + host.pid + '\\n'));",
  "host.stdout.pipe(process.stdout);",
].join(" ");

/**
 * Spawns the host with `args` after its source, through
 * {@link CONPTY_DEPENDENCIES} with the plugin's own spawn options.
 */
async function spawnHost(
  python: string,
  control: WindowsNamedPipeControlChannel,
  args: readonly string[],
): Promise<{
  readonly host: ChildProcessWithoutNullStreams;
  readonly output: () => string;
}> {
  const source = await CONPTY_DEPENDENCIES.materializeSource(
      await loadHostSource(),
    ),
    host = await CONPTY_DEPENDENCIES.spawn(
      python,
      ["-I", "-S", "-B", source, ...args],
      { env: { ...process.env, [TOKEN_ENV]: control.token } },
    ),
    chunks: Buffer[] = [];
  host.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return {
    host,
    output: () => stripVTControlCharacters(Buffer.concat(chunks).toString()),
  };
}

/**
 * {@link spawnHost} from a {@link HOST_PARENT} that stands in for Obsidian.
 */
async function spawnFromParent(
  python: string,
  control: WindowsNamedPipeControlChannel,
  args: readonly string[],
): Promise<{
  readonly parent: ChildProcessWithoutNullStreams;
  readonly output: () => string;
}> {
  const nativeSpawn = childProcess.spawn.bind(childProcess);
  vi.spyOn(childProcess, "spawn").mockImplementationOnce(
    (executable, hostArgs, options) => {
      const { env: parentEnv, ...hostOptions } = options;
      return nativeSpawn(
        process.execPath,
        [
          "-e",
          HOST_PARENT,
          executable,
          JSON.stringify(hostArgs),
          JSON.stringify(hostOptions),
        ],
        { env: parentEnv, stdio: "pipe" },
      );
    },
  );
  const { host: parent, output } = await spawnHost(python, control, args);
  return { parent, output };
}

/** Waits for `label` and the PID after it in `output`. */
async function printedPid(
  output: () => string,
  label: string,
): Promise<number> {
  return vi.waitFor(
    () => {
      const match = new RegExp(`${label} (\\d+)`, "u").exec(output());
      if (!match?.[1]) throw new Error(`Waiting for ${label}`);
      return Number(match[1]);
    },
    { timeout: TIMEOUT_MS },
  );
}

/** Whether process `pid` still runs; a refused probe counts as running. */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

describe.skipIf(process.platform !== "win32")("real ConPTY protocol", () => {
  let python = "";
  beforeAll(async () => {
    // uv puts the matrix venv on PATH. Its Windows redirector launches another
    // PID, so spawn the base interpreter itself for the production PID check.
    const result = await promisify(execFile)(
      "python",
      [
        "-I",
        "-c",
        "import sys; print(getattr(sys, '_base_executable', sys.executable))",
      ],
      { timeout: TIMEOUT_MS },
    );
    python = result.stdout.trim();
    expect(win32.isAbsolute(python)).toBe(true);
  }, TIMEOUT_MS + 1000);

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { consoleHost: "default", warm: false },
    { consoleHost: "default", warm: true },
    { consoleHost: "off", warm: false },
    { consoleHost: "off", warm: true },
  ] as const)(
    "exchanges the complete contract (console host $consoleHost, warm=$warm)",
    async ({ consoleHost, warm }) => {
      const settings = contractSettings(consoleHost),
        fixture = await nativeFixture(python, settings);
      try {
        const spare = warm ? await fixture.spare() : null,
          pty = fixture.open(),
          host = await bounded(pty.shell, "PTY readiness"),
          channel = only(fixture.channels),
          spawned = only(fixture.hosts);
        expect(host).toBe(spawned.host);
        if (spare) expect(host).toBe(spare.host); // No silent cold retry.
        await assertReady(channel, spawned, warm, settings);
        await vi.waitFor(
          () => {
            expect(spawned.output()).toContain(BARRIER);
          },
          {
            timeout: TIMEOUT_MS,
          },
        );
        const onResized = channel.control.onResized,
          resized = vi.fn((event: ConPtyResizedEvent) => {
            onResized?.(event);
          });
        channel.control.onResized = resized;
        await bounded(pty.resize(100, 40), "resize send");
        await vi.waitFor(
          () => {
            expect(resized).toHaveBeenCalledExactlyOnceWith({
              event: "resized",
              columns: 100,
              rows: 40,
              seq: 1,
            });
          },
          { timeout: TIMEOUT_MS },
        );
        // The child cannot exit until both the wire and parsed resize ack exist.
        expect(connection(channel).events().at(-1)).toEqual({
          event: "resized",
          columns: 100,
          rows: 40,
          seq: 1,
        });
        await bounded(
          writePromise(host.stdin, "continue\r\n"),
          "input barrier",
        );
        expect(await bounded(pty.onExit, "PTY exit")).toBe(3);
        await bounded(spawned.closed, "stdout drain");
        expect(stripVTControlCharacters(spawned.output())).toMatch(
          /(?:^|[\r\n])hi[ \t]*(?:\r?\n|$)/u,
        );
        // An OS process exit of 3 alone must never make this test pass.
        expect(channel.control.reportedExitCode()).toBe(3);
        const wire = connection(channel);
        expect(wire.events().map(({ event }) => event)).toEqual([
          ...(warm ? ["idle"] : []),
          "hello",
          "ready",
          "resized",
          "exit",
        ]);
        expect(wire.events().at(-1)).toEqual({ event: "exit", code: 3 });
        expect(wire.operations().map(({ op }) => op)).toEqual([
          "authenticate",
          ...(warm ? ["start"] : []),
          "resize",
        ]);
        expect(wire.operations().at(-1)).toEqual({
          op: "resize",
          columns: 100,
          rows: 40,
          seq: 1,
        });
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );

  it("kills a live shell through the real control pipe", async () => {
    const fixture = await nativeFixture(python);
    try {
      const pty = fixture.open();
      await bounded(pty.shell, "live readiness");
      const channel = only(fixture.channels),
        spawned = only(fixture.hosts);
      await assertReady(channel, spawned, false);
      await vi.waitFor(
        () => {
          expect(spawned.output()).toContain(BARRIER);
        },
        {
          timeout: TIMEOUT_MS,
        },
      );
      await bounded(pty.kill(), "live kill");
      expect(await bounded(pty.onExit, "killed exit")).toBe(1);
      expect(channel.control.reportedExitCode()).toBe(1);
      const wire = connection(channel);
      expect(wire.operations()).toEqual([
        { op: "authenticate", token: channel.control.token },
        { op: "kill" },
      ]);
      expect(wire.events().map(({ event }) => event)).toEqual([
        "hello",
        "ready",
        "exit",
      ]);
      expect(wire.events().at(-1)).toEqual({ event: "exit", code: 1 });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it("ends what the shell left in a hidden console before the quit task settles", async () => {
    const fixture = await nativeFixture(python),
      listeners: ((tasks: unknown) => unknown)[] = [],
      offref = vi.fn(),
      context = Object.assign(
        new TerminalPlugin(new App(), {
          id: "conpty-contract",
          name: "ConPTY contract",
          author: "test",
          description: "Native protocol test",
          version: "0.0.0",
          minAppVersion: "1.4.11",
        }),
        {
          // Records the quit hook, as Obsidian's workspace would hold it.
          app: {
            workspace: {
              offref,
              on: vi.fn(
                (name: string, callback: (tasks: unknown) => unknown) => {
                  if (name === "quit") listeners.push(callback);
                  return {};
                },
              ),
            },
          },
        },
      ),
      tasks: Promise<unknown>[] = [];
    Object.assign(context.settings, { value: contractSettings("default") });
    let helper = 0;
    try {
      const pty = new ConPtyPseudoterminal(
        context,
        {
          executable: python,
          args: ["-c", HIDDEN_HELPER_SHELL],
          pythonExecutable: python,
          columns: 80,
          rows: 24,
        },
        fixture.dependencies,
      );
      await bounded(pty.shell, "helper session readiness");
      const spawned = only(fixture.hosts);
      helper = await vi.waitFor(
        () => {
          const match = /HELPER-PID (\d+)/u.exec(
            stripVTControlCharacters(spawned.output()),
          );
          if (!match?.[1]) throw new Error("Waiting for the helper's PID");
          return Number(match[1]);
        },
        { timeout: TIMEOUT_MS },
      );
      expect(processRuns(helper)).toBe(true);
      expect(listeners).toHaveLength(1);
      for (const listener of listeners) {
        listener({
          add: (task: () => Promise<unknown>): void => {
            tasks.push(task());
          },
        });
      }
      expect(tasks).toHaveLength(1);
      await bounded(Promise.all(tasks), "quit task");
      // The quit task settles once the host has exited: the helper has to be
      // gone by now.
      expect(processRuns(helper)).toBe(false);
      await bounded(pty.onExit, "quit exit");
      await vi.waitFor(() => {
        expect(offref).toHaveBeenCalledTimes(1);
      });
    } finally {
      if (helper && processRuns(helper)) process.kill(helper);
      await fixture.cleanup();
    }
  }, 60_000);

  it.each([
    { consoleHost: "auto", kill: true },
    { consoleHost: null, kill: false },
  ] as const)(
    "ends what the shell left in a hidden console once Obsidian has gone (console host $consoleHost, kill $kill)",
    async ({ consoleHost, kill }) => {
      // Obsidian's window can close before the quit task settles, and a crash
      // runs none: the window's process, the host's parent, is gone while
      // the host still has the session to end.
      const channel = await recordedChannel(false);
      let parent: ChildProcessWithoutNullStreams | undefined,
        helper = 0,
        hostPid = 0;
      try {
        const spawned = await spawnFromParent(python, channel.control, [
          "80",
          "24",
          channel.control.path,
          ...(consoleHost === null ? [] : ["--console-host", consoleHost]),
          "--",
          python,
          "-c",
          HIDDEN_HELPER_SHELL,
        ]);
        ({ parent } = spawned);
        ({ hostPid } = await bounded(channel.control.ready, "session ready"));
        helper = await printedPid(spawned.output, "HELPER-PID");
        expect(processRuns(helper)).toBe(true);
        if (kill) await bounded(channel.control.kill(), "kill");
        parent.kill();
        await channel.control.dispose();
        await vi.waitFor(
          () => {
            expect(processRuns(hostPid)).toBe(false);
          },
          { timeout: TIMEOUT_MS },
        );
        expect(processRuns(helper)).toBe(false);
      } finally {
        for (const pid of [helper, hostPid])
          if (pid && processRuns(pid)) process.kill(pid);
        parent?.kill();
        await channel.control.dispose();
      }
    },
    60_000,
  );

  it("ends an idle spare once Obsidian has gone", async () => {
    // A spare outlives the window too; it must not wait for a session forever.
    const channel = await recordedChannel(true);
    let parent: ChildProcessWithoutNullStreams | undefined,
      hostPid = 0;
    try {
      const spawned = await spawnFromParent(python, channel.control, [
        "--defer-session",
        channel.control.path,
      ]);
      ({ parent } = spawned);
      await bounded(channel.control.idleAuthenticated, "idle authentication");
      hostPid = await printedPid(spawned.output, "HOST-PID");
      parent.kill();
      await channel.control.dispose();
      await vi.waitFor(
        () => {
          expect(processRuns(hostPid)).toBe(false);
        },
        { timeout: TIMEOUT_MS },
      );
    } finally {
      if (hostPid && processRuns(hostPid)) process.kill(hostPid);
      parent?.kill();
      await channel.control.dispose();
    }
  }, 60_000);

  it.each([{ consoleHost: "auto" }, { consoleHost: null }] as const)(
    "interrupts the shell's program on Ctrl+C when the host is spawned as the plugin spawns it (console host $consoleHost)",
    async ({ consoleHost }) => {
      // A process started in a new process group ignores Ctrl+C, and every
      // process it creates inherits that: the shell and what runs in it.
      const channel = await recordedChannel(false);
      let host: ChildProcessWithoutNullStreams | undefined;
      try {
        const spawned = await spawnHost(python, channel.control, [
          "80",
          "24",
          channel.control.path,
          ...(consoleHost === null ? [] : ["--console-host", consoleHost]),
          "--",
          python,
          "-c",
          CTRL_C_SHELL,
        ]);
        ({ host } = spawned);
        await bounded(channel.control.ready, "session ready");
        await vi.waitFor(
          () => {
            expect(spawned.output()).toContain("WAITING-FOR-CTRL-C");
          },
          { timeout: TIMEOUT_MS },
        );
        host.stdin.write("\x03");
        await vi.waitFor(
          () => {
            expect(spawned.output()).toContain("INTERRUPTED");
          },
          { timeout: TIMEOUT_MS },
        );
      } finally {
        host?.kill();
        await channel.control.dispose();
      }
    },
    60_000,
  );

  it("kills an authenticated idle spare without starting a shell", async () => {
    const fixture = await nativeFixture(python);
    try {
      await fixture.spare();
      const channel = only(fixture.channels),
        spawned = only(fixture.hosts);
      await bounded(channel.control.kill(), "idle kill");
      await bounded(spawned.closed, "idle host exit");
      expect(spawned.host.exitCode).toBe(0);
      expect(spawned.token).toBe(channel.control.token);
      const wire = connection(channel);
      expect(wire.events()).toEqual([
        {
          event: "idle",
          token: channel.control.token,
          hostPid: spawned.host.pid,
        },
      ]);
      expect(wire.operations()).toEqual([
        { op: "authenticate", token: channel.control.token },
        { op: "kill" },
      ]);
      expect(fixture.pool.acquire(python)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it("reaps an invalidated spare without stopping an acquired session", async () => {
    const fixture = await nativeFixture(python);
    try {
      const acquired = await fixture.spare(),
        pty = fixture.open(),
        host = await bounded(pty.shell, "acquired readiness"),
        activeChannel = only(fixture.channels),
        activeHost = only(fixture.hosts);
      expect(host).toBe(acquired.host);
      await assertReady(activeChannel, activeHost, true);
      await vi.waitFor(
        () => {
          expect(activeHost.output()).toContain(BARRIER);
        },
        { timeout: TIMEOUT_MS },
      );
      const spare = await fixture.spare(),
        idleChannel = fixture.channels.find(
          ({ control }) => control === spare.control,
        ),
        idleHost = fixture.hosts.find(({ host }) => host === spare.host);
      if (!idleChannel || !idleHost)
        throw new Error("Missing idle host resources");
      fixture.pool.clear();
      await bounded(idleHost.closed, "invalidated host exit");
      await bounded(idleChannel.closed, "invalidated control disposal");
      expect(fixture.pool.acquire(python)).toBeNull();
      expect(
        idleHost.host.exitCode !== null || idleHost.host.signalCode !== null,
      ).toBe(true);
      expect(idleChannel.server.listening).toBe(false);
      expect(connection(idleChannel).socket.destroyed).toBe(true);
      expect(
        connection(idleChannel)
          .events()
          .map(({ event }) => event),
      ).toEqual(["idle"]);
      expect(host.killed).toBe(false);
      expect(host.exitCode).toBeNull();
      expect(connection(activeChannel).socket.destroyed).toBe(false);
      await bounded(
        writePromise(host.stdin, "continue\r\n"),
        "input after invalidation",
      );
      expect(await bounded(pty.onExit, "acquired session exit")).toBe(3);
      await bounded(activeHost.closed, "acquired stdout drain");
      expect(stripVTControlCharacters(activeHost.output())).toMatch(
        /(?:^|[\r\n])hi[ \t]*(?:\r?\n|$)/u,
      );
      expect(activeChannel.control.reportedExitCode()).toBe(3);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
});
