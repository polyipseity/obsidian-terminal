declare module "electron" {
  /**
   * Electron `webUtils` module for file and media utilities.
   *
   * Provides utilities for file handling in the renderer process, including
   * path resolution for dropped or pasted files.
   *
   * Available in Electron 30+. See the Electron documentation for full API details.
   *
   * @see https://github.com/electron/electron/blob/main/docs/api/web-utils.md
   */
  interface WebUtils {
    /**
     * Resolves the file path from a `File` object.
     *
     * Electron 32+ removed the `File.path` property. This method provides a
     * reliable cross-version way to extract file paths from `File` objects,
     * supporting both older and newer Electron versions.
     *
     * @param file - The `File` object to extract the path from (e.g., from
     *               drag-and-drop, file input, or clipboard paste).
     * @returns The absolute file path.
     *
     * @throws Error if the file path cannot be determined.
     *
     * @example
     * ```ts
     * import { webUtils } from "electron";
     * const path = webUtils.getPathForFile(file);
     * console.log("File path:", path);
     * ```
     */
    getPathForFile(file: File): string;
  }

  /**
   * `webUtils` export from the Electron main module.
   *
   * Exposed when importing the `"electron"` module in the renderer process via
   * `require("electron")` or `await import("electron")`.
   *
   * `undefined` when running in non-Electron environments or when the module
   * is unavailable.
   *
   * @see WebUtils for available utilities.
   */
  const webUtils: WebUtils | undefined;
}

declare global {
  interface File {
    /**
     * Legacy `path` property available on `File` objects in Electron < 32.
     *
     * This non-standard property was available in older Electron versions for
     * accessing file paths from `File` objects in the renderer process. It was
     * removed in Electron 32 in favor of the standardized `webUtils.getPathForFile()`
     * API.
     *
     * @deprecated Electron 32+: Use `electron.webUtils.getPathForFile(file)` instead.
     * For older Electron versions (< 30), this property provides a fallback.
     *
     * @see https://github.com/electron/electron/blob/main/docs/api/web-utils.md
     * @see WebUtils.getPathForFile for the recommended replacement.
     */
    readonly path?: string | undefined;
  }
}

import type {} from "electron";
