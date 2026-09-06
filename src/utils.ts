// eslint-disable-next-line eslint-comments/no-restricted-disable -- See below.
// eslint-disable-next-line obsidianmd/no-nodejs-modules -- Type-only import.
import type { ChildProcess } from "node:child_process";
// eslint-disable-next-line eslint-comments/no-restricted-disable -- See below.
// eslint-disable-next-line obsidianmd/no-nodejs-modules -- Type-only import.
import type { Writable } from "node:stream";
import type { AsyncOrSync } from "ts-essentials";

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
