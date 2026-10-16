import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import {
  ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { Server } from "node:net";
import { PassThrough } from "node:stream";
import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPlugin } from "../../../src/main.js";
import { DisposerAddon } from "../../../src/terminal/emulator-addons.js";
import { XtermTerminalEmulator } from "../../../src/terminal/emulator.js";
import * as environment from "../../../src/terminal/environment.js";
import {
  ConPtyControlError,
  ConPtyHostPool,
  ConPtyPseudoterminal,
  type Pseudoterminal,
  RefPsuedoterminal,
  WindowsNamedPipeControlChannel,
} from "../../../src/terminal/pseudoterminal.js";
import { tick } from "../../support/helpers.js";

// ConPTY consumes the plugin's context; plugin loading and UI setup are outside
// this lifecycle test and would eagerly load unrelated rendering addons.
vi.mock("../../../src/main.js", () => ({
  TerminalPlugin: class {
    public readonly register = vi.fn();
    public readonly language = { value: { t: vi.fn((key: string) => key) } };
    public readonly settings = {
      value: { errorNoticeTimeout: 0, prewarmConPty: false },
    };
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

class TestAddon implements ITerminalAddon {
  public activate(_terminal: Terminal): void {}
  public dispose(): void {}
}

interface StubDimensions {
  readonly cols: number;
  readonly rows: number;
}
type StubAddons = {
  readonly fit: TestAddon & {
    readonly proposeDimensions: () => StubDimensions | undefined;
  };
  readonly serialize: TestAddon & { readonly serialize: () => string };
};

function stubAddons(
  proposeDimensions: () => StubDimensions | undefined = (): undefined =>
    undefined,
  fit: TestAddon = new TestAddon(),
): StubAddons {
  return {
    fit: Object.assign(fit, { proposeDimensions }),
    serialize: Object.assign(new TestAddon(), { serialize: (): string => "" }),
  };
}

describe("XtermTerminalEmulator lifecycle", () => {
  it.each([
    {
      description: "restores a mid-page scroll position",
      scrollLine: (baseY: number): number => baseY - 2,
      expectedLine: (baseY: number): number => baseY - 2,
    },
    {
      description: "restores the bottom sentinel to the bottom",
      scrollLine: (): number => XtermTerminalEmulator.State.SCROLL_LINE_BOTTOM,
      expectedLine: (baseY: number): number => baseY,
    },
    {
      description: "clamps a scroll position beyond the buffer",
      scrollLine: (baseY: number): number => baseY + 1,
      expectedLine: (baseY: number): number => baseY,
    },
  ])("$description", async ({ scrollLine, expectedLine }) => {
    const baseY = 92;
    const state: XtermTerminalEmulator.State = {
        columns: 80,
        data: Array.from(
          { length: 101 },
          (_, line) => `${String(line)}\r\n`,
        ).join(""),
        rows: 10,
        scrollLine: scrollLine(baseY),
      },
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn((terminal: Terminal): Pseudoterminal => {
          expect(terminal.buffer.active.baseY).toBe(baseY);
          return {
            kill: vi.fn(),
            onExit: Promise.resolve(0),
            pipe: vi.fn(),
          };
        }),
        state,
        undefined,
        stubAddons(),
      );
    const scrollToLine = vi.spyOn(emulator.terminal, "scrollToLine"),
      scrollToBottom = vi.spyOn(emulator.terminal, "scrollToBottom");
    try {
      await emulator.pseudoterminal;
      expect(emulator.terminal.buffer.active.baseY).toBe(baseY);
      if (
        scrollLine(baseY) === XtermTerminalEmulator.State.SCROLL_LINE_BOTTOM
      ) {
        expect(scrollToBottom).toHaveBeenCalledOnce();
      } else {
        expect(scrollToLine).toHaveBeenCalledWith(expectedLine(baseY));
      }
    } finally {
      await emulator.close(false);
    }
  });

  it("waits for piping before exposing or resizing the pseudoterminal", async () => {
    const created = Promise.withResolvers<Pseudoterminal>(),
      piped = Promise.withResolvers<undefined>(),
      pipeStarted = Promise.withResolvers<undefined>(),
      pseudoterminal: Pseudoterminal = {
        kill: vi.fn(),
        onExit: Promise.resolve(0),
        pipe: vi.fn(() => {
          pipeStarted.resolve(undefined);
          return piped.promise;
        }),
        resize: vi.fn().mockResolvedValue(undefined),
      };
    const emulator = new XtermTerminalEmulator(
      document.createElement("div"),
      vi.fn(() => created.promise),
      undefined,
      undefined,
      stubAddons(() => ({ cols: 80, rows: 24 })),
    );
    const ready = vi.fn(),
      resized = emulator.resize(true);
    void emulator.pseudoterminal.then(ready);
    try {
      // A pre-session resize must wait for the pseudoterminal instead of
      // reaching a backend that does not exist yet.
      await tick();
      expect(pseudoterminal.resize).not.toHaveBeenCalled();
      created.resolve(pseudoterminal);
      await pipeStarted.promise;
      await tick();
      expect(ready).not.toHaveBeenCalled();
      expect(pseudoterminal.resize).not.toHaveBeenCalled();
      piped.resolve(undefined);
      await resized;
      expect(ready).toHaveBeenCalledWith(pseudoterminal);
      expect(pseudoterminal.resize).toHaveBeenCalledWith(80, 24);
    } finally {
      created.resolve(pseudoterminal);
      piped.resolve(undefined);
      await resized;
      await emulator.close(false);
    }
  });

  it.each([true, false])(
    "kills while piping is pending and joins piping before disposal (required: %s)",
    async (mustClosePseudoterminal) => {
      const pipeStarted = Promise.withResolvers<undefined>(),
        piped = Promise.withResolvers<undefined>(),
        exit = Promise.withResolvers<number>(),
        element = document.body.appendChild(document.createElement("div")),
        lateAddon = new TestAddon(),
        disposeLateAddon = vi.spyOn(lateAddon, "dispose"),
        kill = vi.fn(),
        emulator = new XtermTerminalEmulator(
          element,
          vi.fn((): Pseudoterminal => ({
            kill,
            onExit: exit.promise,
            pipe: vi.fn(async (terminal: Terminal) => {
              pipeStarted.resolve(undefined);
              await piped.promise;
              terminal.loadAddon(lateAddon);
            }),
          })),
          undefined,
          undefined,
          stubAddons(),
        );
      await pipeStarted.promise;
      const dispose = vi.spyOn(emulator.terminal, "dispose"),
        settled = vi.fn(),
        closing = emulator.close(mustClosePseudoterminal);
      void closing.then(settled);
      try {
        expect(element.isConnected).toBe(false);
        await tick();
        expect(kill).toHaveBeenCalledOnce();
        expect(dispose).not.toHaveBeenCalled();

        piped.resolve(undefined);
        await tick();
        expect(dispose).toHaveBeenCalledOnce();
        expect(disposeLateAddon).toHaveBeenCalledOnce();
        expect(settled).not.toHaveBeenCalled();
      } finally {
        piped.resolve(undefined);
        exit.resolve(0);
        await closing;
        element.remove();
      }
    },
  );

  it.each(["aborted", "returned", "failed"])(
    "aborts a pending factory and handles its %s result",
    async (result) => {
      const created = Promise.withResolvers<Pseudoterminal>(),
        factory = vi.fn(
          (_terminal: Terminal, _addons: unknown, _signal?: AbortSignal) =>
            created.promise,
        ),
        kill = vi.fn(),
        emulator = new XtermTerminalEmulator(
          document.createElement("div"),
          factory,
          undefined,
          undefined,
          stubAddons(),
        );
      await tick();
      const signal = factory.mock.calls[0]?.[2],
        dispose = vi.spyOn(emulator.terminal, "dispose"),
        closing = emulator.close(true),
        outcome = closing.catch((error: unknown) => error),
        error = new Error("factory failed during close");
      try {
        expect(signal?.aborted).toBe(true);
      } finally {
        if (result === "returned") {
          created.resolve({ kill, onExit: Promise.resolve(0), pipe: vi.fn() });
        } else {
          created.reject(
            result === "aborted" ? new ConPtyControlError("aborted") : error,
          );
        }
        await outcome;
      }
      if (result === "failed") await expect(closing).rejects.toBe(error);
      else await expect(closing).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledTimes(result === "returned" ? 1 : 0);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("aborts a warm ConPTY before hello without starting a cold host", async () => {
    // Keep the real control promises, but avoid opening a native pipe or process.
    const server = new Server();
    vi.spyOn(server, "listen").mockImplementation(() => {
      server.emit("listening");
      return server;
    });
    vi.spyOn(environment, "applyEnv").mockResolvedValue({});
    const control = await WindowsNamedPipeControlChannel.create({
        createServer: vi.fn(() => server),
        randomUUID: vi.fn(() => "emulator-test"),
        deferred: true,
      }),
      start = vi.spyOn(control, "start").mockResolvedValue(undefined),
      stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough(),
      host = Object.assign(new ChildProcess(), {
        stdin,
        stdout,
        stderr,
        stdio: [
          stdin,
          stdout,
          stderr,
          null,
          null,
        ] satisfies ChildProcessWithoutNullStreams["stdio"],
      }),
      killHost = vi.spyOn(host, "kill").mockImplementation(() => {
        // Model the process exit observed after an early termination request.
        Object.defineProperty(host, "signalCode", { value: "SIGTERM" });
        host.emit("exit", null, "SIGTERM");
        return true;
      }),
      pool = new ConPtyHostPool(),
      context = new TerminalPlugin(new App(), {
        id: "emulator-test",
        name: "Emulator test",
        version: "0.0.0",
        minAppVersion: "1.4.11",
        description: "Emulator lifecycle test",
        author: "test",
      }),
      dependencies = {
        // A regression must fail promptly instead of hanging in a cold handshake.
        createControl: vi
          .fn()
          .mockRejectedValue(new Error("unexpected cold host")),
        materializeSource: vi.fn().mockResolvedValue("test-host.py"),
        source: Promise.resolve("test host"),
        spawn: vi.fn().mockResolvedValue(host),
        pool,
      };
    vi.spyOn(pool, "acquire").mockReturnValue({ control, host, generation: 0 });
    const pty = new ConPtyPseudoterminal(
        context,
        { executable: "cmd.exe", pythonExecutable: "test-python" },
        dependencies,
      ),
      kill = vi.spyOn(pty, "kill"),
      pipe = vi.spyOn(pty, "pipe"),
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn(() => new RefPsuedoterminal(pty)),
        undefined,
        undefined,
        stubAddons(),
      );
    await tick();
    const closing = emulator.close();
    try {
      expect(start).toHaveBeenCalledOnce();
      expect(pipe).toHaveBeenCalledOnce();
      await tick();
      expect(kill).toHaveBeenCalledOnce();
      await closing;
      await expect(emulator.pseudoterminal).rejects.toMatchObject({
        reason: "aborted",
      });
      await expect(pty.shell).rejects.toMatchObject({ reason: "aborted" });
      await expect(pty.onExit).rejects.toMatchObject({ reason: "aborted" });
      expect(killHost).toHaveBeenCalled();
      expect(dependencies.createControl).not.toHaveBeenCalled();
      expect(dependencies.spawn).not.toHaveBeenCalled();
    } finally {
      await control.dispose();
      await closing.catch(vi.fn());
      pool.dispose();
      host.stdin.destroy();
      host.stdout.destroy();
      host.stderr.destroy();
    }
  });

  it("disposes after a pending pipe rejects during close", async () => {
    const pipeStarted = Promise.withResolvers<undefined>(),
      piped = Promise.withResolvers<undefined>(),
      kill = vi.fn(),
      error = new Error("pipe failed"),
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn((): Pseudoterminal => ({
          kill,
          onExit: Promise.resolve(0),
          pipe: vi.fn(() => {
            pipeStarted.resolve(undefined);
            return piped.promise;
          }),
        })),
        undefined,
        undefined,
        stubAddons(),
      );
    await pipeStarted.promise;
    const dispose = vi.spyOn(emulator.terminal, "dispose"),
      closing = emulator.close(false);
    try {
      piped.reject(error);
      await expect(emulator.pseudoterminal).rejects.toBe(error);
      await closing;
      expect(kill).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      piped.reject(error);
      await closing;
    }
  });

  it.each([true, false])(
    "handles a kill failure (required: %s)",
    async (mustClosePseudoterminal) => {
      vi.spyOn(console, "debug").mockImplementation(vi.fn());
      const piped = Promise.withResolvers<undefined>(),
        pipeStarted = Promise.withResolvers<undefined>(),
        pipe = vi.fn(() => {
          pipeStarted.resolve(undefined);
          return piped.promise;
        }),
        kill = vi.fn().mockRejectedValue(new Error("seeded kill failure")),
        pseudoterminal: Pseudoterminal = {
          kill,
          onExit: new Promise<number>(() => {}),
          pipe,
        },
        factory = vi.fn(() => pseudoterminal),
        addons = stubAddons(),
        emulator = new XtermTerminalEmulator(
          document.createElement("div"),
          factory,
          undefined,
          undefined,
          addons,
        );

      await pipeStarted.promise;
      const dispose = vi.spyOn(emulator.terminal, "dispose"),
        closing = emulator.close(mustClosePseudoterminal),
        outcome = closing.catch((error: unknown) => error);
      try {
        await tick();
        expect(kill).toHaveBeenCalledOnce();
        expect(dispose).not.toHaveBeenCalled();
      } finally {
        piped.resolve(undefined);
        await outcome;
      }
      if (mustClosePseudoterminal)
        await expect(closing).rejects.toThrow("seeded kill failure");
      else await expect(closing).resolves.toBeUndefined();

      expect(factory).toHaveBeenCalledWith(
        expect.anything(),
        emulator.addons,
        expect.any(AbortSignal),
      );
      expect(pipe).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("detaches during startup but lets piping finish before disposal", async () => {
    let resolvePty = (_pty: Pseudoterminal): void => {};
    const element = document.body.appendChild(document.createElement("div")),
      emulator = new XtermTerminalEmulator(
        element,
        () =>
          new Promise<Pseudoterminal>((resolve) => {
            resolvePty = resolve;
          }),
        undefined,
        undefined,
        stubAddons(),
      );
    // Start the asynchronous factory, leaving its result pending.
    await Promise.resolve();
    const dispose = vi.spyOn(emulator.terminal, "dispose"),
      pipe = vi.fn(() => {
        expect(dispose).not.toHaveBeenCalled();
      }),
      kill = vi.fn(),
      closing = emulator.close();
    try {
      expect(element.isConnected).toBe(false);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      resolvePty({ kill, onExit: Promise.resolve(0), pipe });
      await closing;
      element.remove();
    }
    expect(pipe).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes cleanly after the pseudoterminal factory fails", async () => {
    const emulator = new XtermTerminalEmulator(
      document.createElement("div"),
      vi.fn(() => {
        throw new Error("factory failed");
      }),
      undefined,
      undefined,
      stubAddons(),
    );
    const dispose = vi.spyOn(emulator.terminal, "dispose");

    await expect(emulator.pseudoterminal).rejects.toThrow("factory failed");
    await emulator.close(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "detaches before kill settles and disposes before exit (required: %s)",
    async (mustClosePseudoterminal) => {
      let resolveKill = (): void => {},
        resolveExit = (_exit: number): void => {};
      const killed = new Promise<void>((resolve) => {
          resolveKill = resolve;
        }),
        onExit = new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        element = document.body.appendChild(document.createElement("div")),
        disposer = new DisposerAddon(() => {
          element.remove();
        }),
        kill = vi.fn(() => killed),
        emulator = new XtermTerminalEmulator(
          element,
          vi.fn((): Pseudoterminal => ({
            kill,
            onExit,
            pipe: vi.fn(),
          })),
          undefined,
          undefined,
          { ...stubAddons(), disposer },
        );

      await emulator.pseudoterminal;
      const dispose = vi.spyOn(emulator.terminal, "dispose"),
        disposeAddon = vi.spyOn(disposer, "dispose"),
        settled = vi.fn(),
        closing = emulator.close(mustClosePseudoterminal);
      void closing.then(settled);
      try {
        expect(element.isConnected).toBe(false);
        await Promise.resolve();
        expect(kill).toHaveBeenCalledOnce();
        expect(dispose).not.toHaveBeenCalled();

        resolveKill();
        await vi.waitFor(() => {
          expect(dispose).toHaveBeenCalledOnce();
        });
        expect(disposeAddon).toHaveBeenCalledOnce();
        expect(settled).not.toHaveBeenCalled();
      } finally {
        resolveKill();
        resolveExit(0);
        await closing;
        element.remove();
      }
      expect(settled).toHaveBeenCalledOnce();
    },
  );

  it("applies each xterm resize before sending it to the PTY", async () => {
    const order: string[] = [],
      resize = vi.fn(() => {
        order.push("pty");
        return Promise.resolve();
      }),
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn((): Pseudoterminal => ({
          kill: vi.fn(),
          onExit: Promise.resolve(0),
          pipe: vi.fn(),
          resize,
        })),
        undefined,
        undefined,
        stubAddons(() => ({ cols: 132, rows: 43 })),
      );
    await emulator.pseudoterminal;
    const xtermResize = vi
      .spyOn(emulator.terminal, "resize")
      .mockImplementation(() => {
        order.push("xterm");
      });
    vi.useFakeTimers();
    try {
      const resizing = emulator.resize();
      await vi.advanceTimersByTimeAsync(1_000);
      await resizing;

      expect(xtermResize).toHaveBeenCalledWith(132, 43);
      expect(resize).toHaveBeenCalledWith(132, 43);
      expect(order).toEqual(["xterm", "pty"]);
    } finally {
      vi.useRealTimers();
      await emulator.close(false);
    }
  });

  it("coalesces resize requests down to the applied sizes", async () => {
    const dimensions: readonly {
        readonly cols: number;
        readonly rows: number;
      }[] = [
        { cols: 80, rows: 24 },
        { cols: 100, rows: 30 },
        { cols: 132, rows: 43 },
      ],
      resize = vi.fn().mockResolvedValue(undefined);
    let dimensionIndex = 0;
    const emulator = new XtermTerminalEmulator(
      document.createElement("div"),
      vi.fn((): Pseudoterminal => ({
        kill: vi.fn(),
        onExit: Promise.resolve(0),
        pipe: vi.fn(),
        resize,
      })),
      undefined,
      undefined,
      stubAddons(() => dimensions[dimensionIndex]),
    );
    await emulator.pseudoterminal;
    const xtermResize = vi
      .spyOn(emulator.terminal, "resize")
      .mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const first = emulator.resize();
      dimensionIndex = 1;
      const second = emulator.resize();
      dimensionIndex = 2;
      const third = emulator.resize();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([first, second, third]);

      // The throttle drops the middle request; the trailing size still lands.
      expect(xtermResize.mock.calls).toEqual([
        [80, 24],
        [132, 43],
      ]);
      expect(resize).toHaveBeenLastCalledWith(132, 43);
    } finally {
      vi.useRealTimers();
      await emulator.close(false);
    }
  });

  it("repeats identical PTY sizes without resize acknowledgment", async () => {
    const resize = vi.fn().mockResolvedValue(undefined),
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn((): Pseudoterminal => ({
          kill: vi.fn(),
          onExit: Promise.resolve(0),
          pipe: vi.fn(),
          resize,
        })),
        undefined,
        undefined,
        stubAddons(() => ({ cols: 80, rows: 24 })),
      );
    await emulator.pseudoterminal;
    vi.useFakeTimers();
    try {
      for (let count = 0; count < 2; ++count) {
        const resizing = emulator.resize();
        await vi.advanceTimersByTimeAsync(1_000);
        await resizing;
      }
      expect(resize.mock.calls).toEqual([
        [80, 24],
        [80, 24],
      ]);
    } finally {
      vi.useRealTimers();
      await emulator.close(false);
    }
  });

  it.each([
    { cols: 100, rows: 24 },
    { cols: 80, rows: 30 },
  ])("skips unchanged PTY sizes and sends $cols by $rows", async (changed) => {
    const dimensions = vi.fn(() => ({ cols: 80, rows: 24 })),
      resize = vi.fn().mockResolvedValue(undefined),
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn((): Pseudoterminal => ({
          kill: vi.fn(),
          onExit: Promise.resolve(0),
          pipe: vi.fn(),
          resize,
          resizeIsAcknowledged: true,
        })),
        undefined,
        undefined,
        stubAddons(dimensions),
      );
    await emulator.pseudoterminal;
    vi.useFakeTimers();
    try {
      for (let count = 0; count < 2; ++count) {
        const resizing = emulator.resize();
        await vi.advanceTimersByTimeAsync(1_000);
        await resizing;
      }
      expect(resize.mock.calls).toEqual([[80, 24]]);

      dimensions.mockReturnValue(changed);
      const resizing = emulator.resize();
      await vi.advanceTimersByTimeAsync(1_000);
      await resizing;
      expect(resize.mock.calls).toEqual([
        [80, 24],
        [changed.cols, changed.rows],
      ]);
    } finally {
      vi.useRealTimers();
      await emulator.close(false);
    }
  });

  it.each([true, false])(
    "forgets the last PTY size after rejection and retries (required: %s)",
    async (required) => {
      vi.spyOn(console, "debug").mockImplementation(vi.fn());
      const dimensions = vi.fn(() => ({ cols: 80, rows: 24 })),
        resize = vi.fn().mockResolvedValue(undefined),
        emulator = new XtermTerminalEmulator(
          document.createElement("div"),
          vi.fn((): Pseudoterminal => ({
            kill: vi.fn(),
            onExit: Promise.resolve(0),
            pipe: vi.fn(),
            resize,
            resizeIsAcknowledged: true,
          })),
          undefined,
          undefined,
          stubAddons(dimensions),
        );
      await emulator.pseudoterminal;
      vi.useFakeTimers();
      try {
        const first = emulator.resize();
        await vi.advanceTimersByTimeAsync(1_000);
        await first;

        const error = new Error("resize failed");
        resize.mockRejectedValueOnce(error);
        dimensions.mockReturnValue({ cols: 100, rows: 30 });
        const failed = emulator
          .resize(required)
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await failed).toBe(required ? error : undefined);

        // A failed resize may have partially applied, invalidating the old size.
        dimensions.mockReturnValue({ cols: 80, rows: 24 });
        const restored = emulator.resize();
        await vi.advanceTimersByTimeAsync(1_000);
        await restored;
        dimensions.mockReturnValue({ cols: 100, rows: 30 });
        const retry = emulator.resize();
        await vi.advanceTimersByTimeAsync(1_000);
        await retry;
        const repeated = emulator.resize();
        await vi.advanceTimersByTimeAsync(1_000);
        await repeated;
        expect(resize.mock.calls).toEqual([
          [80, 24],
          [100, 30],
          [80, 24],
          [100, 30],
        ]);
      } finally {
        vi.useRealTimers();
        await emulator.close(false);
      }
    },
  );

  it("sends a return to the previous size while another PTY resize is pending", async () => {
    const dimensions = vi.fn(() => ({ cols: 80, rows: 24 })),
      resize = vi.fn().mockResolvedValue(undefined),
      pending = Promise.withResolvers<undefined>(),
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn((): Pseudoterminal => ({
          kill: vi.fn(),
          onExit: Promise.resolve(0),
          pipe: vi.fn(),
          resize,
          resizeIsAcknowledged: true,
        })),
        undefined,
        undefined,
        stubAddons(dimensions),
      );
    await emulator.pseudoterminal;
    vi.useFakeTimers();
    try {
      const first = emulator.resize();
      await vi.advanceTimersByTimeAsync(1_000);
      await first;

      resize.mockReturnValueOnce(pending.promise);
      dimensions.mockReturnValue({ cols: 100, rows: 30 });
      const delayed = emulator.resize();
      await vi.advanceTimersByTimeAsync(1_000);
      dimensions.mockReturnValue({ cols: 80, rows: 24 });
      const restored = emulator.resize();
      await vi.advanceTimersByTimeAsync(1_000);
      await restored;
      expect(resize.mock.calls).toEqual([
        [80, 24],
        [100, 30],
        [80, 24],
      ]);

      // A late completion cannot replace the most recently sent size.
      pending.resolve(undefined);
      await delayed;
      dimensions.mockReturnValue({ cols: 100, rows: 30 });
      for (let count = 0; count < 2; ++count) {
        const resizing = emulator.resize();
        await vi.advanceTimersByTimeAsync(1_000);
        await resizing;
      }
      expect(resize.mock.calls).toEqual([
        [80, 24],
        [100, 30],
        [80, 24],
        [100, 30],
      ]);
    } finally {
      pending.resolve(undefined);
      vi.useRealTimers();
      await emulator.close(false);
    }
  });
});
