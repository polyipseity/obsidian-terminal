import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { XtermTerminalEmulator } from "../../../src/terminal/emulator.js";
import type { Pseudoterminal } from "../../../src/terminal/pseudoterminal.js";

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
  it("waits for the pseudoterminal before resizing it", async () => {
    const pseudoterminal: Pseudoterminal = {
      kill: vi.fn(),
      onExit: Promise.resolve(0),
      pipe: vi.fn(),
      resize: vi.fn().mockResolvedValue(undefined),
    };
    let resolvePty: (pty: Pseudoterminal) => void = () => {};
    const emulator = new XtermTerminalEmulator(
      document.createElement("div"),
      () =>
        new Promise<Pseudoterminal>((resolve) => {
          resolvePty = resolve;
        }),
      undefined,
      undefined,
      stubAddons(() => ({ cols: 80, rows: 24 })),
    );
    try {
      const resized = emulator.resize(true);
      // A pre-session resize must wait for the pseudoterminal instead of
      // reaching a backend that does not exist yet.
      await new Promise((resolve) => {
        self.setTimeout(resolve, 0);
      });
      expect(pseudoterminal.resize).not.toHaveBeenCalled();
      resolvePty(pseudoterminal);
      await resized;
      expect(pseudoterminal.resize).toHaveBeenCalledWith(80, 24);
    } finally {
      await emulator.close(false);
    }
  });

  it("pipes the pseudoterminal and swallows an optional close failure", async () => {
    vi.spyOn(console, "debug").mockImplementation(vi.fn());
    const pipe = vi.fn().mockResolvedValue(undefined),
      kill = vi.fn().mockRejectedValue(new Error("seeded kill failure")),
      pseudoterminal: Pseudoterminal = {
        kill,
        onExit: Promise.resolve(0),
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

    await emulator.pseudoterminal;
    await pseudoterminal.onExit;
    await Promise.resolve();
    await emulator.close(false);

    expect(factory).toHaveBeenCalledWith(expect.anything(), emulator.addons);
    expect(pipe).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
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

  it("keeps closing pending until the child actually exits", async () => {
    let resolveExit = (_exit: number): void => {};
    const onExit = new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      emulator = new XtermTerminalEmulator(
        document.createElement("div"),
        vi.fn((): Pseudoterminal => ({
          kill: vi.fn(),
          onExit,
          pipe: vi.fn(),
        })),
        undefined,
        undefined,
        stubAddons(),
      );

    await emulator.pseudoterminal;
    const settled = vi.fn(),
      closing = emulator.close();
    void closing.finally(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    resolveExit(0);
    await closing;
    expect(settled).toHaveBeenCalledOnce();
  });

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
});
