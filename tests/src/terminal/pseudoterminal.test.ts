/** Native contract coverage complements the platform-free .spec.ts suite. */
import {
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { App } from "obsidian";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TerminalPlugin } from "../../../src/main.js";
import {
  CONPTY_DEPENDENCIES,
  ConPtyHostPool,
  ConPtyPseudoterminal,
  type ConPtyPseudoterminalDependencies,
  type ConPtyResizedEvent,
  type ConPtySpareHost,
  WindowsNamedPipeControlChannel,
} from "../../../src/terminal/pseudoterminal.js";
import { writePromise } from "../../../src/utils.js";

// Only the Obsidian UI context is replaced. All protocol, environment,
// materialization, pool, and process behavior comes from shipped code.
vi.mock("../../../src/main.js", () => ({
  TerminalPlugin: class {
    public readonly register = vi.fn();
    public readonly language = { value: { t: vi.fn((key: string) => key) } };
    public readonly settings = {
      // Each test explicitly owns its spare; no automatic refill races cleanup.
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

/** Isolated real pool with ownership tracking, reusable for spare lifecycle tests. */
async function nativeFixture(python: string) {
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
      pool.ensureSpare(python, dependencies);
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

async function assertReady(
  channel: RecordedChannel,
  spawned: RecordedHost,
  warm: boolean,
): Promise<void> {
  const { control } = channel,
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
    expect(start?.env).toHaveProperty("TES166_CONTRACT", "字");
  } else {
    expect(spawned.args.slice(-COMMAND.length)).toEqual(COMMAND);
    expect(spawned.args).not.toContain("--defer-session");
  }
}

// The fixture's source loading must work in Vitest even off Windows.
it("loads the real Python host source in the test environment", async () => {
  expect((await loadHostSource()).length).toBeGreaterThan(0);
});

// Explicit off-Windows skips are intentional: mocks cannot establish this contract.
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

  it.each([false, true])(
    "exchanges the complete contract (warm=%s)",
    async (warm) => {
      const fixture = await nativeFixture(python);
      try {
        const spare = warm ? await fixture.spare() : null,
          pty = fixture.open(),
          host = await bounded(pty.shell, "PTY readiness"),
          channel = only(fixture.channels),
          spawned = only(fixture.hosts);
        expect(host).toBe(spawned.host);
        if (spare) expect(host).toBe(spare.host); // No silent cold retry.
        await assertReady(channel, spawned, warm);
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
