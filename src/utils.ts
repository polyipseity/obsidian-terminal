import { createDocumentFragment } from "@polyipseity/obsidian-plugin-library";
// eslint-disable-next-line eslint-comments/no-restricted-disable -- See below.
// eslint-disable-next-line obsidianmd/no-nodejs-modules -- Type-only import.
import type { ChildProcess } from "node:child_process";
// eslint-disable-next-line eslint-comments/no-restricted-disable -- See below.
// eslint-disable-next-line obsidianmd/no-nodejs-modules -- Type-only import.
import type { Writable } from "node:stream";
import type { Setting } from "obsidian";
import type { AsyncOrSync } from "ts-essentials";

/**
 * Sets a setting's description to content built in the document that shows it.
 *
 * `Setting.setDesc` hands a fragment to Obsidian's `Element.setText`, which
 * inserts it only if it is an `instanceof DocumentFragment` of the window that
 * made the description element, and shows anything else as text. The settings
 * tab's elements come from the main window even when Obsidian 1.14 shows the
 * tab in its own Settings window, so a fragment from that window's document was
 * shown as "[object DocumentFragment]". `replaceChildren` takes nodes from any
 * window.
 */
export function setSettingDesc<T extends Setting>(
  setting: T,
  build: (fragment: DocumentFragment) => void,
): T {
  const { descEl } = setting;
  descEl.replaceChildren(createDocumentFragment(descEl.ownerDocument, build));
  return setting;
}

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
