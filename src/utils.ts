import type { AsyncOrSync } from "ts-essentials";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

export async function spawnPromise<T extends ChildProcess>(
  spawn: () => AsyncOrSync<T>,
): Promise<T> {
  const ret = await spawn();
  return new Promise<T>((resolve, reject) => {
    ret
      .once("spawn", () => {
        resolve(ret);
      })
      .once("error", reject);
  });
}

export async function writePromise(
  stream: Writable,
  chunk: unknown,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const written = stream.write(chunk, (error) => {
      if (error) {
        reject(error);
      } else if (written) {
        resolve();
      }
    });
    if (!written) {
      stream.once("drain", resolve);
    }
  });
}
