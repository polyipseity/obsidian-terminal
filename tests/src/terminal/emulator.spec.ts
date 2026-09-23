import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { DisposerAddon } from "../../../src/terminal/emulator-addons.js";
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
        vi.fn((): Pseudoterminal => ({
          kill: vi.fn(),
          onExit: Promise.resolve(0),
          pipe: vi.fn(),
        })),
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

  it.each([true, false])(
    "handles a kill failure (required: %s)",
    async (mustClosePseudoterminal) => {
      vi.spyOn(console, "debug").mockImplementation(vi.fn());
      const pipe = vi.fn().mockResolvedValue(undefined),
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

      await emulator.pseudoterminal;
      const dispose = vi.spyOn(emulator.terminal, "dispose"),
        closing = emulator.close(mustClosePseudoterminal);
      if (mustClosePseudoterminal) {
        await expect(closing).rejects.toThrow("seeded kill failure");
      } else {
        await expect(closing).resolves.toBeUndefined();
      }

      expect(factory).toHaveBeenCalledWith(expect.anything(), emulator.addons);
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
});
