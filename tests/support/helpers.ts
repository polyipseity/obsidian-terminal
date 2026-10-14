/**
 * tests/helpers.ts
 *
 * Lightweight, documented test helpers used across unit tests.
 * Goals:
 *  - Reduce duplication by centralizing mock creation
 *  - Provide strongly typed factories to avoid `as` casts in individual tests
 *  - Keep implementations minimal and easy to stub / spy on
 */
import type { Pseudoterminal } from "../../src/terminal/pseudoterminal.js";

/**
 * Wait for the next macrotask tick — useful to await scheduled IIFEs or setImmediate usage
 * in the library code under test.
 */
export function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/**
 * Lets the queued microtasks run and nothing else: no timer, animation frame
 * or other task runs before the caller continues, so a browser would paint no
 * frame in between. The number of turns is slack, not a count to rely on.
 */
export async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 16; turn++) {
    await Promise.resolve();
  }
}

/** A stub `Pseudoterminal`, plus whatever names its backend. */
export function pseudoterminal(
  backend: Pick<Pseudoterminal, "win32Backend"> = {},
): Pseudoterminal {
  return {
    kill: (): void => {},
    onExit: Promise.resolve(0),
    pipe: (): void => {},
    ...backend,
  };
}
