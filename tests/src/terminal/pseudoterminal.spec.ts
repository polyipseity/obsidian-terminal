import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalPlugin } from "../../../src/main.js";
import {
  TERMINAL_RESIZER_WATCHDOG_WAIT,
  WINDOWS_CONHOST_PATH,
} from "../../../src/magic.js";
import {
  CONPTY_DEPENDENCIES,
  CONPTY_READY_TIMEOUT_MS,
  ConPtyHostPool,
  logChildStderr,
  type ConPtyControlChannel,
  ConPtyControlError,
  ConPtyPseudoterminal,
  createResizeRepaintWindow,
  createTerminalOutputBackpressure,
  type ConPtyPseudoterminalDependencies,
  type ConPtyReadyEvent,
  pipeShellToTerminal,
  WindowsNamedPipeControlChannel,
  WindowsPseudoterminal,
  encodeConPtyOp,
  normalizeConPtyDimension,
  parseConPtyHostEvent,
  selectWin32Pseudoterminal,
  splitConPtyLines,
  writeTerminalSliced,
} from "../../../src/terminal/pseudoterminal.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A terminal that records every `write` payload. */
function captureTerminal(): {
  readonly payloads: (Buffer | string)[];
  readonly terminal: Terminal;
} {
  const payloads: (Buffer | string)[] = [],
    terminal = {
      element: document.createElement("div"),
      loadAddon: (): void => {},
      onData: () => ({ dispose: (): void => {} }),
      rows: 24,
      write: (data: Buffer | string, callback?: () => void): void => {
        payloads.push(data);
        callback?.();
      },
    } as unknown as Terminal;
  return { payloads, terminal };
}

function payloadSizes(payloads: readonly (Buffer | string)[]): number[] {
  return payloads.map((payload) =>
    typeof payload === "string" ? payload.length : payload.byteLength,
  );
}

const KEEPALIVE_SCRIPT = "process.stdin.resume(); setInterval(() => {}, 1000);";

interface LegacyFixture {
  readonly pty: WindowsPseudoterminal;
  readonly processes: { conhost?: ChildProcess; resizer?: ChildProcess };
  readonly cleanup: () => void;
}

/**
 * A ConHost pseudoterminal whose conhost and resizer spawns run `node -e`
 * scripts: the console keeps alive until killed and the resizer runs
 * `resizerScript`.
 */
function legacyFixture(resizerScript: string): LegacyFixture {
  const nativeSpawn = childProcess.spawn.bind(childProcess),
    processes: LegacyFixture["processes"] = {};
  vi.spyOn(childProcess, "spawn").mockImplementation(
    (executable, args, options) => {
      if (executable === "test-python") {
        processes.resizer = nativeSpawn(
          process.execPath,
          ["-e", resizerScript],
          options,
        );
        return processes.resizer;
      }
      if (executable === WINDOWS_CONHOST_PATH) {
        processes.conhost = nativeSpawn(
          process.execPath,
          ["-e", KEEPALIVE_SCRIPT],
          options,
        );
        return processes.conhost;
      }
      return nativeSpawn(executable, args, options);
    },
  );
  const context = {
    language: {
      onChangeLanguage: { listen: vi.fn(() => vi.fn()) },
      value: { t: vi.fn(() => "terminal error") },
    },
    resourceSampler: {
      trackResource: vi.fn(() => ({ close: vi.fn() })),
    },
    settings: { value: { errorNoticeTimeout: 0 } },
  } as unknown as TerminalPlugin;
  return {
    cleanup: (): void => {
      for (const child of [processes.conhost, processes.resizer])
        if (child?.exitCode === null && child.signalCode === null) child.kill();
    },
    processes,
    pty: new WindowsPseudoterminal(context, {
      executable: "C:\\Windows\\System32\\cmd.exe",
      pythonExecutable: "test-python",
      win32Backend: "legacy",
    }),
  };
}

describe("Windows ConHost path", () => {
  it("opens through the real conhost spawn and pipes its output", async () => {
    const nativeSpawn = childProcess.spawn.bind(childProcess),
      spawn = vi
        .spyOn(childProcess, "spawn")
        .mockImplementation((executable, args, options) => {
          if (executable !== WINDOWS_CONHOST_PATH)
            return nativeSpawn(executable, args, options);
          return nativeSpawn(
            process.execPath,
            ["-e", "setTimeout(() => process.exit(0), 50)"],
            options,
          );
        }),
      context = {
        language: { value: { t: vi.fn(() => "terminal error") } },
        settings: { value: { errorNoticeTimeout: 0 } },
      } as unknown as TerminalPlugin,
      // No backend argument: this pseudoterminal always runs conhost.
      pty = new WindowsPseudoterminal(context, {
        executable: "C:\\Windows\\System32\\cmd.exe",
      });

    const shell = await Promise.race([
      pty.shell,
      new Promise<never>((_, reject) => {
        window.setTimeout(() => {
          reject(
            new Error(
              `ConHost shell stayed pending: ${JSON.stringify(
                spawn.mock.calls.map(([executable]) => executable),
              )}`,
            ),
          );
        }, 1000);
      }),
    ]);
    expect(spawn).toHaveBeenCalledWith(
      WINDOWS_CONHOST_PATH,
      expect.any(Array),
      expect.any(Object),
    );
    const write = vi.fn(
        (_data: Buffer | string, callback?: () => void): void => {
          callback?.();
        },
      ),
      terminal = {
        element: document.createElement("div"),
        loadAddon: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        rows: 24,
        write,
      } as unknown as Terminal;
    await pty.pipe(terminal);
    write.mockClear();
    // conhost's console attach emits one junk frame first; the pipe drops it.
    const junkChunk = Buffer.from("legacy-attach-junk"),
      firstChunk = Buffer.from("legacy-first-output");
    shell.stdout.emit("data", junkChunk);
    shell.stdout.emit("data", firstChunk);
    await Promise.resolve();
    expect(write).not.toHaveBeenCalledWith(junkChunk, expect.any(Function));
    expect(write).toHaveBeenCalledWith(firstChunk, expect.any(Function));
    await pty.onExit;
  });

  it("waits for the owned ConHost resizer before reporting PTY exit", async () => {
    const fixture = legacyFixture(
      "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 75)); setInterval(() => {}, 1000);",
    );
    try {
      await fixture.pty.shell;
      let exitResolved = false;
      const exit = fixture.pty.onExit.then((code) => {
        exitResolved = true;
        return code;
      });

      await fixture.pty.kill();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 10);
      });
      expect(exitResolved).toBe(false);
      await exit;
      expect(exitResolved).toBe(true);
      expect(fixture.processes.resizer?.exitCode).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("force-terminates a ConHost resizer that ignores stdin end", async () => {
    const fixture = legacyFixture(
      "process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000);",
    );
    try {
      await fixture.pty.shell;
      await fixture.pty.kill();
      await fixture.pty.onExit;
      const { resizer } = fixture.processes;
      if (resizer === undefined)
        throw new Error("The ConHost resizer process was not spawned.");
      expect(resizer.exitCode !== null || resizer.signalCode !== null).toBe(
        true,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("stops pulsing the resizer watchdog once the resizer exits", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fixture = legacyFixture(KEEPALIVE_SCRIPT);
    try {
      await fixture.pty.shell;
      // `resize` resolves once the resizer owns its PID line and watchdog.
      await fixture.pty.resize(80, 24);
      const { resizer } = fixture.processes;
      if (resizer === undefined)
        throw new Error("The ConHost resizer process was not spawned.");
      if (!resizer.stdin) throw new Error("The ConHost resizer has no stdin.");
      const pulses = vi.spyOn(resizer.stdin, "write");
      vi.advanceTimersByTime(TERMINAL_RESIZER_WATCHDOG_WAIT * 1000);
      expect(pulses).toHaveBeenCalledOnce();

      const exited = new Promise<void>((resolve) => {
        resizer.once("exit", () => {
          resolve();
        });
      });
      resizer.kill();
      await exited;
      pulses.mockClear();
      vi.advanceTimersByTime(TERMINAL_RESIZER_WATCHDOG_WAIT * 3000);
      expect(pulses).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.cleanup();
      vi.useRealTimers();
    }
  });
});

function readyEvent(hostPid = 100, childPid = 200): ConPtyReadyEvent {
  return {
    attestation:
      "create-pseudoconsole+authenticated-control-channel+job-object-assigned",
    childPid,
    controlChannelAuthenticated: true,
    createPseudoConsole: true,
    event: "ready",
    hostPid,
    jobObjectAssigned: true,
  };
}

interface SocketLineReader {
  readonly next: () => Promise<string>;
}

function socketLineReader(socket: Socket): SocketLineReader {
  const lines: string[] = [],
    pending: ((line: string) => void)[] = [];
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const resolve = pending.shift();
      if (resolve) resolve(line);
      else lines.push(line);
      newline = buffer.indexOf("\n");
    }
  });
  return {
    next: async () =>
      new Promise((resolve) => {
        const line = lines.shift();
        if (line === undefined) pending.push(resolve);
        else resolve(line);
      }),
  };
}

describe("ConPTY control protocol", () => {
  it("selects only the explicit ConPTY backend", () => {
    expect(selectWin32Pseudoterminal("conpty")).toBe(ConPtyPseudoterminal);
    expect(selectWin32Pseudoterminal("legacy")).toBe(WindowsPseudoterminal);
    expect(selectWin32Pseudoterminal(void 0)).toBe(WindowsPseudoterminal);
  });

  it("encodes operations as bounded NDJSON records", () => {
    expect(encodeConPtyOp({ columns: 80, op: "resize", rows: 24 })).toBe(
      '{"columns":80,"op":"resize","rows":24}\n',
    );
    expect(
      encodeConPtyOp({ columns: 100, op: "resize", rows: 40, seq: 7 }),
    ).toBe('{"columns":100,"op":"resize","rows":40,"seq":7}\n');
    expect(encodeConPtyOp({ op: "authenticate", token: "secret" })).toBe(
      '{"op":"authenticate","token":"secret"}\n',
    );
  });

  it("parses exact hello, ready, and exit records", () => {
    expect(
      parseConPtyHostEvent(
        '{"event":"hello","token":"t","hostPid":10,"childPid":20}',
      ),
    ).toEqual({
      childPid: 20,
      event: "hello",
      hostPid: 10,
      token: "t",
    });
    expect(parseConPtyHostEvent(JSON.stringify(readyEvent(10, 20)))).toEqual(
      readyEvent(10, 20),
    );
    expect(parseConPtyHostEvent('{"event":"exit","code":3}')).toEqual({
      code: 3,
      event: "exit",
    });
    expect(
      parseConPtyHostEvent(
        '{"event":"resized","columns":100,"rows":40,"seq":3}',
      ),
    ).toEqual({ columns: 100, event: "resized", rows: 40, seq: 3 });
  });

  it("rejects malformed resized acknowledgments", () => {
    expect(
      parseConPtyHostEvent('{"event":"resized","columns":0,"rows":40,"seq":3}'),
    ).toBeNull();
    expect(
      parseConPtyHostEvent(
        '{"event":"resized","columns":100,"rows":40,"seq":0}',
      ),
    ).toBeNull();
    expect(
      parseConPtyHostEvent(
        '{"event":"resized","columns":100,"rows":40,"seq":true}',
      ),
    ).toBeNull();
    expect(
      parseConPtyHostEvent(
        '{"event":"resized","columns":100,"rows":40,"seq":3,"forged":true}',
      ),
    ).toBeNull();
  });

  it("rejects incomplete or forged ready records", () => {
    expect(
      parseConPtyHostEvent(
        JSON.stringify({ ...readyEvent(), jobObjectAssigned: false }),
      ),
    ).toBeNull();
    expect(
      parseConPtyHostEvent(
        JSON.stringify({ ...readyEvent(), attestation: "configured" }),
      ),
    ).toBeNull();
    expect(
      parseConPtyHostEvent(JSON.stringify({ ...readyEvent(), forged: true })),
    ).toBeNull();
    expect(
      parseConPtyHostEvent(
        JSON.stringify({ ...readyEvent(), hostPid: Number.MAX_SAFE_INTEGER }),
      ),
    ).toBeNull();
  });

  it("frames split UTF-8 records and rejects oversized fragments", () => {
    const first = splitConPtyLines(
        Buffer.alloc(0),
        Buffer.from("日本語").subarray(0, 2),
      ),
      second = splitConPtyLines(
        first.rest,
        Buffer.concat([
          Buffer.from("日本語").subarray(2),
          Buffer.from("\nnext\n"),
        ]),
      ),
      overflow = splitConPtyLines(
        Buffer.alloc(0),
        Buffer.from("x".repeat(20)),
        8,
      ),
      terminatedOverflow = splitConPtyLines(
        Buffer.alloc(0),
        Buffer.from(`${"x".repeat(20)}\n`),
        8,
      );
    expect(second.lines).toEqual(["日本語", "next"]);
    expect(overflow).toMatchObject({ overflow: true, lines: [] });
    expect(overflow.rest).toHaveLength(0);
    expect(terminatedOverflow).toMatchObject({ overflow: true, lines: [] });
  });

  it("normalizes dimensions to the Win32 COORD range", () => {
    expect(normalizeConPtyDimension(undefined, 30)).toBe(30);
    expect(normalizeConPtyDimension(0, 30)).toBe(1);
    expect(normalizeConPtyDimension(80.9, 30)).toBe(80);
    expect(normalizeConPtyDimension(1_000_000, 30)).toBe(32_767);
  });
});

describe("Windows named-pipe ConPTY readiness", () => {
  let directory = "";
  const channels: WindowsNamedPipeControlChannel[] = [],
    sockets: Socket[] = [];

  async function newChannel(
    readyTimeoutMs = CONPTY_READY_TIMEOUT_MS,
    deferred = false,
  ): Promise<WindowsNamedPipeControlChannel> {
    const channel = await WindowsNamedPipeControlChannel.create({
      createServer: () => createServer(),
      deferred,
      pipePath: (id) => join(directory, `${id.slice(0, 8)}.sock`),
      randomUUID: () => randomUUID(),
      readyTimeoutMs,
    });
    channels.push(channel);
    return channel;
  }

  function newClient(path: string): Socket {
    const socket = connect(path);
    socket.on("error", () => {});
    sockets.push(socket);
    return socket;
  }

  async function authenticate(
    channel: WindowsNamedPipeControlChannel,
    client: Socket,
    event = readyEvent(),
  ): Promise<SocketLineReader> {
    const reader = socketLineReader(client);
    client.write(
      `${JSON.stringify({
        childPid: event.childPid,
        event: "hello",
        hostPid: event.hostPid,
        token: channel.token,
      })}\n`,
    );
    await expect(channel.hello).resolves.toMatchObject({
      childPid: event.childPid,
      hostPid: event.hostPid,
    });
    await expect(reader.next()).resolves.toBe(
      JSON.stringify({ op: "authenticate", token: channel.token }),
    );
    client.write(`${JSON.stringify(event)}\n`);
    await expect(channel.ready).resolves.toEqual(event);
    return reader;
  }

  /** Sends the idle hello for a deferred channel and awaits its
   * authentication. */
  async function authenticateIdle(
    channel: WindowsNamedPipeControlChannel,
  ): Promise<void> {
    newClient(channel.path).write(
      `${JSON.stringify({
        event: "idle",
        hostPid: 4242,
        token: channel.token,
      })}\n`,
    );
    await channel.idleAuthenticated;
  }

  interface PoolFixture {
    readonly pool: ConPtyHostPool;
    readonly dependencies: ConPtyPseudoterminalDependencies;
    readonly channelsCreated: WindowsNamedPipeControlChannel[];
    readonly spawned: ReturnType<typeof testHost>[];
    /** Resolves the first created channel, or throws if none exists. */
    readonly channel: () => WindowsNamedPipeControlChannel;
    readonly cleanup: () => void;
  }

  /** A pool with dependencies that spawn `testHost` processes over real
   * deferred channels; `overrides` replace individual dependencies. */
  function poolFixture(
    overrides: Partial<ConPtyPseudoterminalDependencies> = {},
  ): PoolFixture {
    const spawned: ReturnType<typeof testHost>[] = [],
      channelsCreated: WindowsNamedPipeControlChannel[] = [],
      pool = new ConPtyHostPool(),
      dependencies: ConPtyPseudoterminalDependencies = {
        createControl: vi.fn(),
        async createDeferredControl() {
          const channel = await newChannel(CONPTY_READY_TIMEOUT_MS, true);
          channelsCreated.push(channel);
          return channel;
        },
        materializeSource: vi.fn().mockResolvedValue("host.py"),
        source: Promise.resolve("test host"),
        async spawn() {
          const host = testHost();
          spawned.push(host);
          return host;
        },
        ...overrides,
      };
    return {
      channel: (): WindowsNamedPipeControlChannel => {
        const channel = channelsCreated[0];
        if (!channel) throw new Error("The spare channel is missing.");
        return channel;
      },
      channelsCreated,
      cleanup: (): void => {
        pool.dispose();
        for (const host of spawned)
          if (host.exitCode === null && host.signalCode === null) host.kill();
      },
      dependencies,
      pool,
      spawned,
    };
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "obsidian-terminal-conpty-"));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const channel of channels.splice(0)) await channel.dispose();
    await rm(directory, { force: true, recursive: true });
  });

  it("fails when no host connects before the ready deadline", async () => {
    const channel = await newChannel(20);
    await expect(channel.ready).rejects.toMatchObject({ reason: "timeout" });
  });

  it("classifies a host death before ready as a failure, not an abort", async () => {
    const channel = await newChannel(),
      client = newClient(channel.path);
    /*
     * The host authenticated its hello and then died mid-handshake. The
     * fallback circuit breaker skips "aborted" (user closed the pane), so
     * this rejection must carry a failure reason or every later open
     * retries the same broken runtime.
     */
    client.write(
      `${JSON.stringify({
        childPid: 20,
        event: "hello",
        hostPid: 10,
        token: channel.token,
      })}\n`,
    );
    await channel.hello;
    client.destroy();
    await expect(channel.ready).rejects.toMatchObject({
      reason: "disconnected",
    });
  });

  it("ignores a stray connection that drops before any hello", async () => {
    const channel = await newChannel(),
      stray = newClient(channel.path);
    await new Promise((resolve) => {
      stray.once("connect", resolve);
    });
    stray.destroy();
    // The real host connects afterwards and still completes the handshake.
    const client = newClient(channel.path);
    await authenticate(channel, client);
  });

  it("ignores garbage from a stray connection", async () => {
    const channel = await newChannel(),
      stray = newClient(channel.path);
    stray.write("not a control event\n");
    const client = newClient(channel.path);
    await authenticate(channel, client);
  });

  it("keeps a user disposal classified as an abort", async () => {
    const channel = await newChannel();
    newClient(channel.path);
    await channel.dispose();
    await expect(channel.ready).rejects.toMatchObject({ reason: "aborted" });
  });

  it("refuses a forged hello token without failing the channel", async () => {
    const channel = await newChannel(),
      client = newClient(channel.path);
    client.write(
      `${JSON.stringify({
        childPid: 20,
        event: "hello",
        hostPid: 10,
        token: "wrong",
      })}\n`,
    );
    /*
     * The genuine host echoes the token from its environment, so a wrong
     * token is a forgery. The forged connection is dropped, and the real
     * host still completes the handshake afterwards.
     */
    await new Promise((resolve) => {
      client.once("close", resolve);
    });
    const real = newClient(channel.path);
    await authenticate(channel, real);
  });

  it("requires the ready identity to match the authenticated hello", async () => {
    const channel = await newChannel(),
      client = newClient(channel.path),
      reader = socketLineReader(client);
    client.write(
      `${JSON.stringify({
        childPid: 20,
        event: "hello",
        hostPid: 10,
        token: channel.token,
      })}\n`,
    );
    await reader.next();
    client.write(`${JSON.stringify(readyEvent(11, 20))}\n`);
    await expect(channel.ready).rejects.toMatchObject({ reason: "protocol" });
  });

  it("coalesces pre-ready resize and then records host exit", async () => {
    const channel = await newChannel(),
      client = newClient(channel.path),
      first = channel.resize(80, 24),
      second = channel.resize(100, 40),
      reader = await authenticate(channel, client);
    await Promise.all([first, second]);
    await expect(reader.next()).resolves.toBe(
      JSON.stringify({ columns: 100, op: "resize", rows: 40 }),
    );
    client.write(`${JSON.stringify({ code: 42, event: "exit" })}\n`);
    await new Promise((resolve) => self.setTimeout(resolve, 10));
    expect(channel.reportedExitCode()).toBe(42);
  });

  it("sends kill only after a complete ready transition", async () => {
    const channel = await newChannel(),
      client = newClient(channel.path),
      reader = await authenticate(channel, client);
    await channel.kill();
    await expect(reader.next()).resolves.toBe(JSON.stringify({ op: "kill" }));
  });

  it("runs the deferred idle-authenticate-start-ready flow", async () => {
    const channel = await newChannel(CONPTY_READY_TIMEOUT_MS, true),
      client = newClient(channel.path),
      reader = socketLineReader(client),
      event = readyEvent();
    client.write(
      `${JSON.stringify({
        event: "idle",
        hostPid: event.hostPid,
        token: channel.token,
      })}\n`,
    );
    await expect(reader.next()).resolves.toBe(
      JSON.stringify({ op: "authenticate", token: channel.token }),
    );
    await channel.idleAuthenticated;
    await channel.start({
      columns: 132,
      command: ["cmd.exe"],
      cwd: "C:\\work",
      env: { A: "1" },
      op: "start",
      rows: 43,
    });
    await expect(reader.next()).resolves.toBe(
      '{"columns":132,"command":["cmd.exe"],"cwd":"C:\\\\work","env":{"A":"1"},"op":"start","rows":43}',
    );
    client.write(
      `${JSON.stringify({
        childPid: event.childPid,
        event: "hello",
        hostPid: event.hostPid,
        token: channel.token,
      })}\n`,
    );
    await expect(channel.hello).resolves.toMatchObject({
      childPid: event.childPid,
    });
    client.write(`${JSON.stringify(event)}\n`);
    await expect(channel.ready).resolves.toEqual(event);
    // The deferred flow authenticates once, before the session.
    await channel.kill();
    await expect(reader.next()).resolves.toBe(JSON.stringify({ op: "kill" }));
  });

  it("rejects starting a session before idle authentication", async () => {
    const channel = await newChannel(CONPTY_READY_TIMEOUT_MS, true);
    await expect(
      channel.start({
        columns: 80,
        command: ["cmd.exe"],
        cwd: null,
        env: {},
        op: "start",
        rows: 24,
      }),
    ).rejects.toMatchObject({ reason: "aborted" });
  });

  it("pools one authenticated spare per executable", async () => {
    const fixture = poolFixture(),
      { channelsCreated, dependencies, pool, spawned } = fixture,
      createDeferredControl = vi.spyOn(dependencies, "createDeferredControl");
    try {
      expect(pool.acquire("python")).toBeNull();
      pool.ensureSpare("python", dependencies);
      // A second ensureSpare while the first is still booting must not
      // boot a second host only to kill it.
      pool.ensureSpare("python", dependencies);
      expect(createDeferredControl).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(channelsCreated).toHaveLength(1);
        expect(spawned).toHaveLength(1);
      });
      // Not yet authenticated: the spare must be left alone.
      expect(pool.acquire("python")).toBeNull();
      await authenticateIdle(fixture.channel());
      // A second ensureSpare while one exists must not spawn another.
      pool.ensureSpare("python", dependencies);
      await new Promise((resolve) => self.setTimeout(resolve, 10));
      expect(spawned).toHaveLength(1);
      const spare = pool.acquire("python");
      expect(spare?.host).toBe(spawned[0]);
      expect(pool.acquire("python")).toBeNull();
      pool.dispose();
      pool.ensureSpare("python", dependencies);
      await new Promise((resolve) => self.setTimeout(resolve, 10));
      expect(spawned).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("discards a spare that finishes booting after a clear", async () => {
    let releaseSpawn: () => void = () => {};
    const spawnGate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      }),
      spawned: ReturnType<typeof testHost>[] = [],
      fixture = poolFixture({
        async spawn() {
          await spawnGate;
          const host = testHost();
          spawned.push(host);
          return host;
        },
      }),
      { dependencies, pool } = fixture;
    try {
      pool.ensureSpare("python", dependencies);
      // The map is still empty here, so only the generation bump can stop
      // the boot that is already in flight.
      pool.clear();
      // Opting back in while the retired boot is still in flight must boot
      // again: the in-flight guard belongs to the old generation.
      pool.ensureSpare("python", dependencies);
      releaseSpawn();
      await vi.waitFor(() => {
        expect(spawned).toHaveLength(2);
      });
      await vi.waitFor(() => {
        expect(spawned[0]?.killed).toBe(true);
      });
      expect(spawned[1]?.killed).toBe(false);
    } finally {
      fixture.cleanup();
      for (const host of spawned)
        if (host.exitCode === null && host.signalCode === null) host.kill();
    }
  });

  it("clears spares without retiring the pool", async () => {
    const fixture = poolFixture(),
      { dependencies, pool, spawned } = fixture;
    try {
      pool.ensureSpare("python", dependencies);
      await vi.waitFor(() => {
        expect(spawned).toHaveLength(1);
      });
      pool.clear();
      expect(spawned[0]?.killed).toBe(true);
      expect(pool.acquire("python")).toBeNull();
      // Unlike dispose, a cleared pool accepts a new spare.
      pool.ensureSpare("python", dependencies);
      await vi.waitFor(() => {
        expect(spawned).toHaveLength(2);
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("disposes despite a silent connection that never speaks", async () => {
    const channel = await newChannel(),
      stray = newClient(channel.path);
    await new Promise((resolve) => {
      stray.once("connect", resolve);
    });
    // Let the server's own accept run before disposal races it.
    await new Promise((resolve) => self.setTimeout(resolve, 50));
    // `server.close()` waits for every accepted connection, so a prober
    // that neither speaks nor leaves must not wedge pane close.
    await expect(
      Promise.race([
        channel.dispose().then(() => "disposed"),
        new Promise((resolve) =>
          self.setTimeout(() => {
            resolve("wedged");
          }, 1_000),
        ),
      ]),
    ).resolves.toBe("disposed");
  });

  it("disposes the deferred channel when source materialization fails", async () => {
    const fixture = poolFixture({
        materializeSource: vi.fn().mockRejectedValue(new Error("disk full")),
        spawn: vi.fn(),
      }),
      { channelsCreated, dependencies, pool } = fixture;
    try {
      pool.ensureSpare("python", dependencies);
      await vi.waitFor(() => {
        expect(channelsCreated).toHaveLength(1);
      });
      // The failure precedes the spawn; the channel must not keep its
      // listening server and armed ready deadline alive regardless.
      await expect(fixture.channel().ready).rejects.toMatchObject({
        reason: "aborted",
      });
      expect(dependencies.spawn).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("takes a released spare back for the next open", async () => {
    const fixture = poolFixture(),
      { channelsCreated, dependencies, pool, spawned } = fixture;
    try {
      pool.ensureSpare("python", dependencies);
      await vi.waitFor(() => {
        expect(channelsCreated).toHaveLength(1);
      });
      await authenticateIdle(fixture.channel());
      const spare = pool.acquire("python");
      if (!spare) throw new Error("The spare was not acquired.");
      // A declined start op leaves the spare untouched; releasing it must
      // arm the next open without paying a second interpreter boot.
      pool.release("python", spare);
      const again = pool.acquire("python");
      expect(again?.host).toBe(spare.host);
      expect(spawned).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("kills a released spare from a retired generation", async () => {
    const fixture = poolFixture(),
      { channelsCreated, dependencies, pool } = fixture;
    try {
      pool.ensureSpare("python", dependencies);
      await vi.waitFor(() => {
        expect(channelsCreated).toHaveLength(1);
      });
      await authenticateIdle(fixture.channel());
      const spare = pool.acquire("python");
      if (!spare) throw new Error("The spare was not acquired.");
      // The user opted out while the caller held the host; re-pooling it
      // would resurrect a spare the clear was meant to remove.
      pool.clear();
      pool.release("python", spare);
      await vi.waitFor(() => {
        expect(spare.host.killed).toBe(true);
      });
      expect(pool.acquire("python")).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it("carries the ack sequence and reports resized acknowledgments", async () => {
    const channel = await newChannel(),
      client = newClient(channel.path),
      acked: unknown[] = [];
    channel.onResized = (event): void => {
      acked.push(event);
    };
    const reader = await authenticate(channel, client);
    await channel.resize(100, 40, 7);
    await expect(reader.next()).resolves.toBe(
      '{"columns":100,"op":"resize","rows":40,"seq":7}',
    );
    client.write('{"event":"resized","columns":100,"rows":40,"seq":7}\n');
    await new Promise((resolve) => self.setTimeout(resolve, 10));
    expect(acked).toEqual([
      { columns: 100, event: "resized", rows: 40, seq: 7 },
    ]);
  });
});

function testHost(script = "setTimeout(() => {}, 10000)") {
  return childProcess.spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function liveHostPid(host: ReturnType<typeof testHost>): number {
  if (typeof host.pid !== "number" || host.pid <= 0)
    throw new Error("The test host did not expose a PID.");
  return host.pid;
}

function fakeControl(
  ready: Promise<ConPtyReadyEvent>,
  onKill: () => void,
): ConPtyControlChannel {
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
    hello: Promise.resolve({
      childPid: 200,
      event: "hello",
      hostPid: 100,
      token: "token",
    }),
    kill: vi.fn(async () => {
      onKill();
    }),
    path: "test-control-pipe",
    ready,
    reportedExitCode: () => null,
    resize: vi.fn().mockResolvedValue(undefined),
    token: "token",
  };
}

function conPtyDependencies(
  control: ConPtyControlChannel,
  host: ReturnType<typeof testHost>,
): ConPtyPseudoterminalDependencies {
  return {
    createControl: async () => control,
    materializeSource: vi.fn().mockResolvedValue("test-host.py"),
    source: Promise.resolve("test host"),
    spawn: vi.fn().mockResolvedValue(host),
  };
}

function constructConPty(
  dependencies: ConPtyPseudoterminalDependencies,
  initialSize?: Readonly<{
    columns?: number;
    rows?: number;
    environment?: readonly (readonly [string, string])[];
  }>,
  t = vi.fn((key: string) => key),
): ConPtyPseudoterminal {
  return new ConPtyPseudoterminal(
    {
      language: {
        onChangeLanguage: { listen: vi.fn(() => vi.fn()) },
        value: { t },
      },
      settings: { value: { errorNoticeTimeout: 0 } },
    } as unknown as TerminalPlugin,
    {
      ...initialSize,
      executable: "cmd.exe",
      pythonExecutable: process.execPath,
    },
    dependencies,
  );
}

describe("ConPTY ready transition", () => {
  it("resolves the shell only against the live host's ready event", async () => {
    const host = testHost(),
      hostPid = liveHostPid(host),
      childPid = hostPid + 1,
      ready = Object.freeze(readyEvent(hostPid, childPid)),
      control = fakeControl(Promise.resolve(ready), () => host.kill()),
      dependencies = conPtyDependencies(control, host),
      pty = constructConPty(dependencies, {
        columns: 132,
        rows: 43,
      });

    const shell = await pty.shell;
    expect(shell).toBe(host);
    expect(dependencies.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "-I",
        "-S",
        "-B",
        "test-host.py",
        "132",
        "43",
        "test-control-pipe",
        "--",
        "cmd.exe",
      ],
      expect.objectContaining({ env: expect.anything() as object }),
    );
    await pty.kill();
    await pty.onExit;
  });

  it("starts a pooled spare instead of spawning", async () => {
    const host = testHost(),
      hostPid = liveHostPid(host),
      ready = Object.freeze(readyEvent(hostPid, hostPid + 1)),
      start = vi.fn().mockResolvedValue(undefined),
      warmControl = {
        ...fakeControl(Promise.resolve(ready), () => host.kill()),
        start,
      },
      pool = {
        acquire: vi.fn(() => ({ control: warmControl, host })),
        dispose: vi.fn(),
        ensureSpare: vi.fn(),
      },
      dependencies = {
        ...conPtyDependencies(
          fakeControl(new Promise<never>(() => {}), () => {}),
          host,
        ),
        pool: pool as unknown as ConPtyHostPool,
      },
      pty = constructConPty(dependencies, {
        columns: 132,
        rows: 43,
      });

    const shell = await pty.shell;
    expect(shell).toBe(host);
    expect(pool.acquire).toHaveBeenCalledWith(process.execPath);
    expect(dependencies.spawn).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: 132,
        command: ["cmd.exe"],
        cwd: null,
        op: "start",
        rows: 43,
      }),
    );
    await pty.kill();
    await pty.onExit;
  });

  it("cold-spawns when a non-ASCII start op exceeds the byte cap", async () => {
    const host = testHost(),
      hostPid = liveHostPid(host),
      ready = Object.freeze(readyEvent(hostPid, hostPid + 1)),
      start = vi.fn().mockResolvedValue(undefined),
      warmControl = {
        ...fakeControl(Promise.resolve(ready), () => host.kill()),
        start,
      },
      pool = {
        acquire: vi.fn(() => ({ control: warmControl, generation: 0, host })),
        dispose: vi.fn(),
        ensureSpare: vi.fn(),
        release: vi.fn(),
      },
      dependencies = {
        ...conPtyDependencies(
          fakeControl(Promise.resolve(ready), () => host.kill()),
          host,
        ),
        pool: pool as unknown as ConPtyHostPool,
      },
      // Each CJK code unit encodes to three UTF-8 bytes, so this value stays
      // far below the cap by string length and far above it by bytes.
      pty = constructConPty(dependencies, {
        environment: [["WIDE", "字".repeat(20_000)]],
      });

    await pty.shell;
    expect(start).not.toHaveBeenCalled();
    expect(dependencies.spawn).toHaveBeenCalled();
    // The spare never saw the oversized op; it goes back to the pool
    // instead of dying for a session it could not serve.
    expect(pool.release).toHaveBeenCalledWith(
      process.execPath,
      expect.objectContaining({ host }),
    );
    expect(warmControl.dispose).not.toHaveBeenCalled();
    await pty.kill();
    await pty.onExit;
  });

  it("rejects a ready event for a different host process", async () => {
    const host = testHost(),
      ready = Object.freeze(readyEvent(liveHostPid(host) + 1)),
      control = fakeControl(Promise.resolve(ready), () => host.kill()),
      pty = constructConPty(conPtyDependencies(control, host));

    await expect(pty.shell).rejects.toMatchObject({ reason: "protocol" });
    await pty.onExit;
    expect(control.dispose).toHaveBeenCalledOnce();
  });

  it("pipes ConPTY output to the terminal and disposes the input listener", async () => {
    const host = testHost(),
      ready = Object.freeze(
        readyEvent(liveHostPid(host), liveHostPid(host) + 1),
      ),
      control = fakeControl(Promise.resolve(ready), () => host.kill()),
      dataListeners: ((data: string) => unknown)[] = [],
      disposeInput = vi.fn(),
      writeOutput = vi.fn((_data: Buffer | string, callback?: () => void) => {
        callback?.();
      }),
      terminal = {
        element: document.createElement("div"),
        loadAddon: vi.fn(),
        onData: vi.fn((listener: (data: string) => unknown) => {
          dataListeners.push(listener);
          return { dispose: disposeInput };
        }),
        rows: 24,
        write: writeOutput,
      } as unknown as Terminal,
      pty = constructConPty(conPtyDependencies(control, host));

    await pty.pipe(terminal);
    const output = Buffer.from("conpty-output");
    host.stdout.emit("data", output);
    await Promise.resolve();
    expect(writeOutput).toHaveBeenCalledWith(output, expect.any(Function));

    const writeInput = dataListeners[0];
    if (!writeInput) throw new Error("The terminal input listener is missing.");
    await writeInput("conpty-input");

    await pty.kill();
    await pty.onExit;
    expect(disposeInput).toHaveBeenCalledOnce();
  });

  it("fails closed when readiness times out", async () => {
    let rejectReady: (reason?: unknown) => void = () => {};
    const readiness = new Promise<ConPtyReadyEvent>((_resolve, reject) => {
        rejectReady = reject;
      }),
      host = testHost(),
      control = fakeControl(readiness, () => host.kill()),
      pty = constructConPty(conPtyDependencies(control, host));

    rejectReady(new ConPtyControlError("timeout"));
    await expect(pty.shell).rejects.toMatchObject({ reason: "timeout" });
    await pty.onExit;
    expect(control.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a host that exits before the ready message", async () => {
    const host = testHost("process.exit(17)"),
      control = fakeControl(new Promise(() => {}), () => host.kill()),
      pty = constructConPty(conPtyDependencies(control, host));

    await expect(pty.shell).rejects.toThrow(
      "errors.conpty-host-exited-before-ready",
    );
    await expect(pty.onExit).resolves.toBe(17);
    expect(control.dispose).toHaveBeenCalledOnce();
  });

  it("kills a live host without waiting for readiness", async () => {
    const host = testHost(),
      control = fakeControl(new Promise(() => {}), () => host.kill()),
      pty = constructConPty(conPtyDependencies(control, host)),
      shellFailure = expect(pty.shell).rejects.toThrow(
        "errors.conpty-host-exited-before-ready",
      );

    await pty.kill();
    await pty.onExit;
    await shellFailure;
    expect(control.kill).not.toHaveBeenCalled();
    expect(control.dispose).toHaveBeenCalledOnce();
  });

  it("shows no error notice when the user closes during boot", async () => {
    let abort = (): void => {};
    const host = testHost(),
      // Mirror the real channel: disposal rejects `ready` as an abort.
      ready = new Promise<ConPtyReadyEvent>((_resolve, reject) => {
        abort = (): void => {
          reject(new ConPtyControlError("aborted", "user closed the pane"));
        };
      }),
      control = {
        ...fakeControl(ready, () => host.kill()),
        dispose: vi.fn(async () => {
          abort();
        }),
      },
      t = vi.fn((key: string) => key),
      pty = constructConPty(conPtyDependencies(control, host), void 0, t),
      shellFailure = expect(pty.shell).rejects.toMatchObject({
        reason: "aborted",
      });

    await pty.kill();
    await shellFailure;
    await pty.onExit;
    expect(t).not.toHaveBeenCalledWith("errors.conpty-control-unauthenticated");
    expect(t).not.toHaveBeenCalledWith("errors.conpty-readiness-timeout");
  });
});

describe("ConPTY source materialization", () => {
  it("caches the host source at a stable content-addressed path", async () => {
    const source = `# test-source ${randomUUID()}`,
      first = await CONPTY_DEPENDENCIES.materializeSource(source),
      second = await CONPTY_DEPENDENCIES.materializeSource(source);
    try {
      expect(second).toBe(first);
      expect(basename(first)).toMatch(
        /^obsidian-terminal-conpty-[0-9a-f]{16}\.py$/u,
      );
      await expect(readFile(first, "utf8")).resolves.toBe(source);
      // Cleanup keeps the cache: later sessions reuse the scanned file.
      await expect(readFile(first, "utf8")).resolves.toBe(source);
      const other = await CONPTY_DEPENDENCIES.materializeSource(
        `${source}-different`,
      );
      try {
        expect(other).not.toBe(first);
      } finally {
        await rm(other, { force: true });
      }
    } finally {
      await rm(first, { force: true });
    }
  });

  it("rewrites the file when a temp cleaner removed it mid-session", async () => {
    const source = `# test-source ${randomUUID()}`,
      first = await CONPTY_DEPENDENCIES.materializeSource(source);
    try {
      await rm(first, { force: true });
      const again = await CONPTY_DEPENDENCIES.materializeSource(source);
      expect(again).toBe(first);
      await expect(readFile(first, "utf8")).resolves.toBe(source);
    } finally {
      await rm(first, { force: true });
    }
  });
});

describe("terminal write slicing", () => {
  it("passes small chunks through unsliced", async () => {
    const { payloads, terminal } = captureTerminal(),
      chunk = Buffer.from("small");
    await writeTerminalSliced(terminal, chunk, 8);
    expect(payloads).toEqual([chunk]);
  });

  it("slices large buffers on the write boundary and preserves order", async () => {
    const { payloads, terminal } = captureTerminal(),
      chunk = Buffer.alloc(20_100, 0x61);
    await writeTerminalSliced(terminal, chunk, 8_192);
    expect(payloadSizes(payloads)).toEqual([8_192, 8_192, 3_716]);
    expect(Buffer.concat(payloads as Buffer[])).toEqual(chunk);
  });

  it("slices strings by code units and reassembles them", async () => {
    const { payloads, terminal } = captureTerminal(),
      chunk = "ab😀".repeat(5);
    await writeTerminalSliced(terminal, chunk, 7);
    expect((payloads as string[]).join("")).toBe(chunk);
    for (const payload of payloads)
      expect((payload as string).length).toBeLessThanOrEqual(7);
    expect(payloads.length).toBeGreaterThan(1);
  });

  it("passes any chunk through whole at an unbounded slice size", async () => {
    // One `Terminal.write` chunk is one uninterruptible parse unit in
    // xterm's write buffer, so an unsliced chunk parses and paints
    // atomically. The repaint window relies on this behavior.
    const { payloads, terminal } = captureTerminal(),
      chunk = Buffer.alloc(20_000, 0x61);
    await writeTerminalSliced(terminal, chunk, Number.POSITIVE_INFINITY);
    expect(payloads).toEqual([chunk]);
  });
});

describe("resize repaint window", () => {
  it("opens on arm and closes when the span lapses", () => {
    let nowMs = 1_000;
    const window0 = createResizeRepaintWindow(0.5, () => nowMs);
    expect(window0.active()).toBe(false);
    window0.arm();
    expect(window0.active()).toBe(true);
    nowMs += 499;
    expect(window0.active()).toBe(true);
    nowMs += 1;
    expect(window0.active()).toBe(false);
  });

  it("re-arming restarts the span", () => {
    let nowMs = 0;
    const window0 = createResizeRepaintWindow(0.1, () => nowMs);
    window0.arm();
    nowMs += 99;
    window0.arm();
    nowMs += 99;
    expect(window0.active()).toBe(true);
    nowMs += 1;
    expect(window0.active()).toBe(false);
  });
});

describe("shell output piping", () => {
  function pipeFixture(): {
    readonly emit: (chunk: Buffer | string) => void;
    readonly payloads: (Buffer | string)[];
    readonly pipe: (
      repaintWindow?: Readonly<{ active: () => boolean }>,
    ) => Promise<void>;
  } {
    const { payloads, terminal } = captureTerminal(),
      listeners: ((chunk: Buffer | string) => void)[] = [],
      output = {
        on: (_event: string, listener: (chunk: Buffer | string) => void) => {
          listeners.push(listener);
        },
        pause: (): void => {},
        removeListener: (): void => {},
        resume: (): void => {},
      },
      shell = { stdin: {} } as unknown as Parameters<
        typeof pipeShellToTerminal
      >[1];
    return {
      emit: (chunk): void => {
        for (const listener of listeners) listener(chunk);
      },
      payloads,
      pipe: async (repaintWindow): Promise<void> => {
        await pipeShellToTerminal(
          terminal,
          shell,
          [output as unknown as Parameters<typeof pipeShellToTerminal>[2][0]],
          new Promise(() => {}),
          { repaintWindow },
        );
        // Drop the screen-clear preamble the pipe writes on attach.
        payloads.length = 0;
      },
    };
  }

  it("slices oversized chunks when no repaint window is given", async () => {
    // The ConHost and Unix reader path: without a repaint window, delivery
    // stays sliced.
    const fixture = pipeFixture();
    await fixture.pipe();
    fixture.emit(Buffer.alloc(20_000, 0x61));
    expect(payloadSizes(fixture.payloads)).toEqual([8_192, 8_192, 3_616]);
  });

  it("writes oversized chunks whole while the repaint window is open", async () => {
    const fixture = pipeFixture();
    await fixture.pipe({ active: () => true });
    fixture.emit(Buffer.alloc(20_000, 0x61));
    expect(payloadSizes(fixture.payloads)).toEqual([20_000]);
  });

  it("returns to sliced writes when the repaint window closes", async () => {
    let active = true;
    const fixture = pipeFixture();
    await fixture.pipe({ active: () => active });
    fixture.emit(Buffer.alloc(20_000, 0x61));
    expect(payloadSizes(fixture.payloads)).toEqual([20_000]);
    fixture.payloads.length = 0;
    active = false;
    fixture.emit(Buffer.alloc(20_000, 0x61));
    expect(payloadSizes(fixture.payloads)).toEqual([8_192, 8_192, 3_616]);
  });
});

describe("ConPTY resize repaint window wiring", () => {
  it("bypasses slicing for output that follows a resize", async () => {
    const host = testHost(),
      hostPid = liveHostPid(host),
      ready = Object.freeze(readyEvent(hostPid, hostPid + 1)),
      control = fakeControl(Promise.resolve(ready), () => host.kill()),
      dependencies = conPtyDependencies(control, host),
      pty = constructConPty(dependencies);
    try {
      const { payloads, terminal } = captureTerminal();
      await pty.pipe(terminal);
      payloads.length = 0;
      host.stdout.emit("data", Buffer.alloc(20_000, 0x61));
      expect(payloadSizes(payloads)).toEqual([8_192, 8_192, 3_616]);
      payloads.length = 0;
      await pty.resize(100, 40);
      host.stdout.emit("data", Buffer.alloc(20_000, 0x61));
      expect(payloadSizes(payloads)).toEqual([20_000]);
    } finally {
      await pty.kill();
      await pty.onExit;
    }
  });

  it("bypasses slicing for output that follows a resize acknowledgment", async () => {
    const host = testHost(),
      hostPid = liveHostPid(host),
      ready = Object.freeze(readyEvent(hostPid, hostPid + 1)),
      control = fakeControl(Promise.resolve(ready), () => host.kill()),
      dependencies = conPtyDependencies(control, host),
      pty = constructConPty(dependencies);
    try {
      const { payloads, terminal } = captureTerminal();
      await pty.pipe(terminal);
      payloads.length = 0;
      expect(control.onResized).toBeDefined();
      control.onResized?.({ columns: 100, event: "resized", rows: 40, seq: 1 });
      host.stdout.emit("data", Buffer.alloc(20_000, 0x61));
      expect(payloadSizes(payloads)).toEqual([20_000]);
    } finally {
      await pty.kill();
      await pty.onExit;
    }
  });
});

describe("terminal output backpressure", () => {
  function pausable(): {
    readonly pause: ReturnType<typeof vi.fn<() => void>>;
    readonly resume: ReturnType<typeof vi.fn<() => void>>;
  } {
    return { pause: vi.fn<() => void>(), resume: vi.fn<() => void>() };
  }

  function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (reason: Error) => void;
  } {
    let resolve0: (() => void) | undefined,
      reject0: ((reason: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolve0 = resolve;
      reject0 = reject;
    });
    if (!resolve0 || !reject0) {
      throw new Error("deferred executor did not run");
    }
    return { promise, reject: reject0, resolve: resolve0 };
  }

  it("pauses every source above the high watermark and resumes below the low watermark", async () => {
    const first = pausable(),
      second = pausable(),
      backpressure = createTerminalOutputBackpressure([first, second], 100, 50),
      writeA = deferred(),
      writeB = deferred();
    backpressure.track(Buffer.alloc(80), writeA.promise);
    expect(first.pause).not.toHaveBeenCalled();
    backpressure.track(Buffer.alloc(80), writeB.promise);
    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(second.pause).toHaveBeenCalledTimes(1);
    writeA.resolve();
    await writeA.promise;
    // 80 pending bytes stay above the low watermark.
    expect(first.resume).not.toHaveBeenCalled();
    writeB.resolve();
    await writeB.promise;
    expect(first.resume).toHaveBeenCalledTimes(1);
    expect(second.resume).toHaveBeenCalledTimes(1);
  });

  it("drains rejected writes and counts string chunks by length", async () => {
    const source = pausable(),
      backpressure = createTerminalOutputBackpressure([source], 10, 5),
      write = deferred();
    backpressure.track("abcdefghijkl", write.promise);
    expect(source.pause).toHaveBeenCalledTimes(1);
    write.reject(new Error("write failed"));
    await write.promise.catch(() => void 0);
    // Wait for the internal settlement callback to run.
    await Promise.resolve();
    expect(source.resume).toHaveBeenCalledTimes(1);
  });

  it("resumes paused sources on dispose and stops tracking", () => {
    const source = pausable(),
      backpressure = createTerminalOutputBackpressure([source], 10, 5);
    backpressure.track(Buffer.alloc(20), deferred().promise);
    expect(source.pause).toHaveBeenCalledTimes(1);
    backpressure.dispose();
    expect(source.resume).toHaveBeenCalledTimes(1);
    backpressure.track(Buffer.alloc(20), deferred().promise);
    expect(source.pause).toHaveBeenCalledTimes(1);
  });
});

describe("child stderr mirroring", () => {
  it("reports every stderr line at error level", () => {
    const listeners: ((chunk: Buffer | string) => void)[] = [],
      child = {
        stderr: {
          on(_event: string, listener: (chunk: Buffer | string) => void) {
            listeners.push(listener);
          },
        },
      } as unknown as Parameters<typeof logChildStderr>[0],
      error = vi.spyOn(console, "error").mockImplementation(vi.fn());
    try {
      logChildStderr(child);
      const emit = listeners[0];
      if (!emit) throw new Error("The stderr listener was not registered.");
      emit("win32_conpty: could not start the session: [WinError 2]\n");
      emit(Buffer.from("Traceback (most recent call last):\n"));
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenLastCalledWith(
        "Traceback (most recent call last):\n",
      );
    } finally {
      error.mockRestore();
    }
  });
});
