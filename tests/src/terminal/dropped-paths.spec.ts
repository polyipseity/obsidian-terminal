/**
 * Unit tests for `src/terminal/dropped-paths.ts`.
 *
 * Covers:
 * - vaultDragPaths: every supported shape of Obsidian's drag manager
 *   draggable, malformed or unsupported shapes, which give no path, and
 *   draggables that throw when they are read
 * - shellGrammar: the grammar of an executable per platform, and of every
 *   integrated profile preset
 * - formatDroppedPath: the text of each grammar for the file names of the
 *   test vault, the Linux path that WSL gets for a Windows one, refused paths
 *   (empty, control characters, no place under WSL), and what a shell and
 *   Claude Code read back from the text, with each known limit pinned
 * - formatDroppedPaths: one text per path, order, duplicates, trailing space,
 *   skipped paths, the cap, the bytes the texts may have
 * - lineByteLimit: the shells whose paste is bounded, per platform
 * - droppedPathPastes: one paste for all the texts off Windows and one per
 *   text on it, and what a shell and Claude Code read back from the one paste
 * - uriListPaths: `file:` URIs and Obsidian resource URLs per platform, the
 *   lists Visual Studio Code was measured to write, fragments, and every kind
 *   of entry that names no local path
 */
import type { Platform } from "@polyipseity/obsidian-plugin-library";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_DROPPED_PATHS,
  type ShellGrammar,
  type UriListOptions,
  droppedPathPastes,
  formatDroppedPath,
  formatDroppedPaths,
  lineByteLimit,
  shellGrammar,
  uriListPaths,
  vaultDragPaths,
} from "../../../src/terminal/dropped-paths.js";
import { PROFILE_PRESETS } from "../../../src/terminal/profile-presets.js";

const GRAMMARS: readonly ShellGrammar[] = [
  "posix",
  "posix-quoted",
  "wsl",
  "powershell",
  "cmd",
];

/**
 * The grammars that write the path they are given. `wsl` writes another one,
 * the Linux path, so it has tables and tests of its own.
 */
type SamePathGrammar = Exclude<ShellGrammar, "wsl">;

describe("vaultDragPaths", () => {
  it.each<readonly [string, unknown, readonly string[]]>([
    [
      "a file",
      { file: { name: "a.md", path: "Notes/a.md" }, type: "file" },
      ["Notes/a.md"],
    ],
    [
      "a folder",
      { file: { children: [], name: "Notes", path: "Notes" }, type: "folder" },
      ["Notes"],
    ],
    [
      "a multi-selection, in drag order",
      {
        files: [{ path: "b.png" }, { path: "Notes/a.md" }, { path: "c.pdf" }],
        type: "files",
      },
      ["b.png", "Notes/a.md", "c.pdf"],
    ],
    [
      "a multi-selection with a folder mixed in",
      {
        files: [
          { path: "a.md" },
          { children: [], path: "Folder" },
          { path: "Folder/b.png" },
        ],
        type: "files",
      },
      ["a.md", "Folder", "Folder/b.png"],
    ],
    [
      "a resolved link",
      {
        file: { path: "Assets/image.png" },
        linktext: "image.png",
        sourcePath: "Notes/a.md",
        type: "link",
      },
      ["Assets/image.png"],
    ],
    [
      "bookmarks of files and folders, skipping groups, searches and URLs",
      {
        items: [
          { item: { path: "a.md", type: "file" } },
          { item: { items: [], title: "Group", type: "group" } },
          { item: { path: "Folder", type: "folder" } },
          { item: { query: "tag:#todo", type: "search" } },
          { item: { type: "url", url: "https://example.com" } },
          { item: { type: "graph" } },
          { item: { path: "b.md", subpath: "#Heading", type: "file" } },
        ],
        type: "bookmarks",
      },
      ["a.md", "Folder", "b.md"],
    ],
    [
      "the card of a Bases board",
      {
        entry: { file: { name: "Task.md", path: "Projects/Task.md" } },
        type: "kanban-card",
      },
      ["Projects/Task.md"],
    ],
    [
      "duplicates in a multi-selection, keeping the first",
      {
        files: [
          { path: "a.md" },
          { path: "b.md" },
          { path: "a.md" },
          { path: "c.md" },
          { path: "b.md" },
        ],
        type: "files",
      },
      ["a.md", "b.md", "c.md"],
    ],
    [
      "duplicates in bookmarks, keeping the first",
      {
        items: [
          { item: { path: "a.md", type: "file" } },
          { item: { path: "a.md", subpath: "#Heading", type: "file" } },
        ],
        type: "bookmarks",
      },
      ["a.md"],
    ],
    [
      "the usable entries of a multi-selection with malformed entries",
      {
        files: [
          null,
          { path: "a.md" },
          void 0,
          "b.md",
          7,
          {},
          { path: "" },
          { path: 1 },
          ["c.md"],
          { path: "d.md" },
        ],
        type: "files",
      },
      ["a.md", "d.md"],
    ],
    [
      "the usable entries of bookmarks with malformed entries",
      {
        items: [
          null,
          {},
          { item: null },
          { item: {} },
          { item: "a.md" },
          { item: { type: "file" } },
          { item: { path: 7, type: "file" } },
          { item: { path: "", type: "file" } },
          { item: { path: "no-type.md" } },
          { item: { path: "not-a-file.md", type: "search" } },
          { item: [{ path: "array.md", type: "file" }] },
          { item: { path: "kept.md", type: "file" } },
        ],
        type: "bookmarks",
      },
      ["kept.md"],
    ],
  ])("returns the paths of %s", (_name, draggable, expected) => {
    expect(vaultDragPaths(draggable)).toEqual(expected);
  });

  it.each<readonly [string, unknown]>([
    ["null", null],
    ["undefined", void 0],
    ["a string", "Notes/a.md"],
    ["a number", 42],
    ["a boolean", true],
    ["a function", (): string => "Notes/a.md"],
    ["an empty array", []],
    ["an array of draggables", [{ file: { path: "a.md" }, type: "file" }]],
    ["an empty object", {}],
    ["an object without a type", { file: { path: "a.md" } }],
    ["an unknown type", { file: { path: "a.md" }, type: "unknown" }],
    ["a type that is not a string", { file: { path: "a.md" }, type: 1 }],
    ["a type in an array", { file: { path: "a.md" }, type: ["file"] }],
    [
      "a heading",
      {
        file: { path: "a.md" },
        heading: { heading: "Title" },
        type: "heading",
      },
    ],
    ["a property", { key: "tags", type: "property" }],
    ["a file drag without a file", { type: "file" }],
    ["a file drag with a null file", { file: null, type: "file" }],
    ["a file without a path", { file: { name: "a.md" }, type: "file" }],
    ["a path of the wrong type", { file: { path: 42 }, type: "file" }],
    ["a path in an array", { file: { path: ["a.md"] }, type: "file" }],
    ["an empty path", { file: { path: "" }, type: "file" }],
    ["a file given as a string", { file: "a.md", type: "file" }],
    ["a file given as an array", { file: [{ path: "a.md" }], type: "file" }],
    [
      "a file that is an array with a path",
      { file: Object.assign([], { path: "a.md" }), type: "file" },
    ],
    [
      "a draggable that is an array with a type",
      Object.assign([], { file: { path: "a.md" }, type: "file" }),
    ],
    ["a folder drag without a file", { type: "folder" }],
    ["a multi-selection without files", { type: "files" }],
    ["files that are not an array", { files: { path: "a.md" }, type: "files" }],
    ["files given as a string", { files: "a.md", type: "files" }],
    ["an empty multi-selection", { files: [], type: "files" }],
    [
      "an unresolved link",
      { file: null, linktext: "Missing", sourcePath: "a.md", type: "link" },
    ],
    [
      "a link without a file field",
      { linktext: "Missing", sourcePath: "a.md", type: "link" },
    ],
    ["a link with an undefined file", { file: void 0, type: "link" }],
    ["bookmarks without items", { type: "bookmarks" }],
    ["items that are not an array", { items: {}, type: "bookmarks" }],
    [
      "a bookmark group",
      { items: [{ item: { items: [], type: "group" } }], type: "bookmarks" },
    ],
    ["a bookmark without an item", { items: [{}], type: "bookmarks" }],
    ["a board card without an entry", { type: "kanban-card" }],
    ["a board card with a null entry", { entry: null, type: "kanban-card" }],
    [
      "a board card whose entry has no file",
      { entry: { path: "a.md" }, type: "kanban-card" },
    ],
    [
      "a board card with a null file",
      { entry: { file: null }, type: "kanban-card" },
    ],
    [
      "a board card whose file has no path",
      { entry: { file: { name: "a.md" } }, type: "kanban-card" },
    ],
    [
      "a board card with its entry in an array",
      { entry: [{ file: { path: "a.md" } }], type: "kanban-card" },
    ],
    [
      "a board card with the file beside the entry",
      { entry: {}, file: { path: "a.md" }, type: "kanban-card" },
    ],
  ])("returns no path for %s", (_name, draggable) => {
    expect(vaultDragPaths(draggable)).toEqual([]);
  });

  /** An object that throws when `key` is read; `rest` holds its other properties. */
  function throwingAt(
    key: string,
    rest: Readonly<Record<string, unknown>> = {},
  ): unknown {
    return Object.defineProperty({ ...rest }, key, {
      enumerable: true,
      get(): never {
        throw new Error(`reading ${key}`);
      },
    });
  }

  /** A revoked proxy: every operation on it throws, `in` and `Array.isArray` too. */
  function revokedProxy(target: object = {}): unknown {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return proxy;
  }

  // Made in the test: a revoked proxy in a table would throw as soon as the
  // runner looked at it.
  it.each<readonly [string, () => unknown]>([
    ["a revoked proxy", (): unknown => revokedProxy()],
    ["a revoked proxy of an array", (): unknown => revokedProxy([])],
    [
      "a proxy that throws when asked for a property",
      (): unknown =>
        new Proxy(
          {},
          {
            has(): never {
              throw new Error("has");
            },
          },
        ),
    ],
    ["a type that throws", (): unknown => throwingAt("type")],
    [
      "a type that throws something other than an error",
      (): unknown =>
        Object.defineProperty({}, "type", {
          get(): never {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- any value can be thrown at the function.
            throw "not an error";
          },
        }),
    ],
    ["a file that throws", (): unknown => throwingAt("file", { type: "file" })],
    [
      "a file that is a revoked proxy",
      (): unknown => ({ file: revokedProxy(), type: "file" }),
    ],
    [
      "a path that throws",
      (): unknown => ({ file: throwingAt("path"), type: "file" }),
    ],
    [
      "a link whose file throws",
      (): unknown => throwingAt("file", { type: "link" }),
    ],
    ["files that throw", (): unknown => throwingAt("files", { type: "files" })],
    [
      "files that throw when listed",
      (): unknown => ({
        files: new Proxy([{ path: "a.md" }], {
          get(): never {
            throw new Error("get");
          },
        }),
        type: "files",
      }),
    ],
    [
      "a multi-selection whose last file throws, after files it could read",
      (): unknown => ({
        files: [{ path: "a.md" }, { path: "b.md" }, throwingAt("path")],
        type: "files",
      }),
    ],
    [
      "a multi-selection with a revoked proxy among its files",
      (): unknown => ({
        files: [{ path: "a.md" }, revokedProxy(), { path: "c.md" }],
        type: "files",
      }),
    ],
    [
      "bookmarks that throw",
      (): unknown => throwingAt("items", { type: "bookmarks" }),
    ],
    [
      "bookmarks with an item that throws, after items it could read",
      (): unknown => ({
        items: [{ item: { path: "a.md", type: "file" } }, throwingAt("item")],
        type: "bookmarks",
      }),
    ],
    [
      "a bookmark whose type throws",
      (): unknown => ({
        items: [{ item: throwingAt("type", { path: "a.md" }) }],
        type: "bookmarks",
      }),
    ],
    [
      "a board card whose entry throws",
      (): unknown => throwingAt("entry", { type: "kanban-card" }),
    ],
    [
      "a board card whose file throws",
      (): unknown => ({ entry: throwingAt("file"), type: "kanban-card" }),
    ],
  ])("returns no path, instead of throwing, for %s", (_name, draggable) => {
    expect(vaultDragPaths(draggable())).toEqual([]);
  });
});

/** Shells of the sh family the plugin recognizes on Windows, by executable name. */
const WIN32_POSIX_SHELLS: readonly string[] = [
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "git-bash",
  "msys2",
  "msys2_shell",
  "mintty",
  "busybox",
  "cygwin",
];

/**
 * Shells that read no quotes as the sh family does: fish has `\\` and `\'` as
 * escapes inside single quotes, csh and tcsh expand `!` there, and all three
 * expand `$` inside double quotes.
 */
const OTHER_SHELLS: readonly string[] = ["fish", "csh", "tcsh"];

const DESKTOP: readonly Platform.Desktop[] = ["darwin", "linux", "win32"];

/** Every integrated preset on each platform it is offered on: `[preset, platform, executable]`. */
const INTEGRATED_PRESETS: readonly (readonly [
  string,
  Platform.Desktop,
  string,
])[] = Object.entries(PROFILE_PRESETS).flatMap(([key, preset]) =>
  preset.type === "integrated"
    ? DESKTOP.filter((platform) => platform in preset.platforms).map(
        (platform): readonly [string, Platform.Desktop, string] => [
          key,
          platform,
          preset.executable,
        ],
      )
    : [],
);

/** The grammar the shell of each integrated preset reads. */
const PRESET_GRAMMARS: Readonly<Record<string, ShellGrammar>> = {
  bashIntegrated: "posix",
  cmdIntegrated: "cmd",
  darwinIntegratedDefault: "posix",
  dashIntegrated: "posix",
  gitBashIntegrated: "posix-quoted",
  linuxIntegratedDefault: "posix",
  powershellIntegrated: "powershell",
  pwshIntegrated: "powershell",
  shIntegrated: "posix",
  win32IntegratedDefault: "cmd",
  wslIntegrated: "wsl",
  zshIntegrated: "posix",
};

describe("shellGrammar", () => {
  it.each<readonly [string, Platform.All, ShellGrammar]>([
    ["/bin/zsh", "darwin", "posix"],
    ["/bin/bash", "linux", "posix"],
    ["/usr/bin/fish", "linux", "posix"],
    ["/opt/homebrew/bin/nu", "darwin", "posix"],
    ["zsh", "darwin", "posix"],
    ["/bin/sh", "android", "posix"],
    ["/bin/sh", "ios", "posix"],
    ["/bin/sh", "unknown", "posix"],
    // Only Windows has a `cmd.exe`.
    ["cmd", "darwin", "posix"],
    ["cmd.exe", "linux", "posix"],
    ["", "darwin", "posix"],
    ["", "linux", "posix"],
    ["", "unknown", "posix"],
    ["", "win32", "cmd"],
    ["cmd", "win32", "cmd"],
    ["cmd.exe", "win32", "cmd"],
    ["C:\\Windows\\System32\\cmd.exe", "win32", "cmd"],
    ["C:/Windows/System32/cmd.exe", "win32", "cmd"],
    ["C:\\WINDOWS\\SYSTEM32\\CMD.EXE", "win32", "cmd"],
    ["nu.exe", "win32", "cmd"],
    ["python.exe", "win32", "cmd"],
    ["claude", "win32", "cmd"],
    ["wt", "win32", "cmd"],
    ["C:\\Program Files\\nodejs\\node.exe", "win32", "cmd"],
    ["powershell", "win32", "powershell"],
    ["powershell.exe", "win32", "powershell"],
    ["PowerShell.EXE", "win32", "powershell"],
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "win32",
      "powershell",
    ],
    ["powershell_ise.exe", "win32", "powershell"],
    ["powershell_ise", "win32", "powershell"],
    ["pwsh-preview.exe", "win32", "powershell"],
    // A script or a `.com` program starts the shell as well as an `.exe`.
    ["pwsh.cmd", "win32", "powershell"],
    ["PWSH.BAT", "win32", "powershell"],
    ["powershell.com", "win32", "powershell"],
    ["C:\\tools\\pwsh-preview.cmd", "win32", "powershell"],
    // By its exact name: another program may only start like PowerShell.
    ["powershell-core", "win32", "cmd"],
    ["powershellx.exe", "win32", "cmd"],
    ["pwsh7.exe", "win32", "cmd"],
    ["pwshd", "win32", "cmd"],
    ["pwsh-daily", "linux", "posix"],
    ["/usr/local/bin/powershell-wrapper", "darwin", "posix"],
    ["pwsh", "win32", "powershell"],
    ["pwsh.exe", "win32", "powershell"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32", "powershell"],
    ["C:/Program Files/PowerShell/7/pwsh.exe", "win32", "powershell"],
    ["pwsh", "darwin", "powershell"],
    ["pwsh", "linux", "powershell"],
    ["/usr/local/bin/pwsh", "darwin", "powershell"],
    ["/opt/microsoft/powershell/7/pwsh", "linux", "powershell"],
    ["pwsh-preview", "linux", "powershell"],
    ["powershell", "unknown", "powershell"],
    ["C:\\Program Files\\Git\\bin\\bash.exe", "win32", "posix-quoted"],
    ["C:/msys64/usr/bin/zsh.exe", "win32", "posix-quoted"],
    ["C:\\Program Files\\Git\\git-bash.exe", "win32", "posix-quoted"],
    ["C:\\Windows\\System32\\wsl.exe", "win32", "wsl"],
    ["wsl", "win32", "wsl"],
    ["WSL.EXE", "win32", "wsl"],
    // Off Windows a program of that name is not the one of Windows.
    ["/usr/local/bin/wsl", "linux", "posix"],
    // The exact name only: these two do not start a shell.
    ["C:\\Windows\\System32\\wslhost.exe", "win32", "cmd"],
    ["wslg.exe", "win32", "cmd"],
    ["BASH.EXE", "win32", "posix-quoted"],
    ["C:\\msys64\\msys2_shell.cmd", "win32", "posix-quoted"],
    ["C:\\cygwin64\\Cygwin.bat", "win32", "posix-quoted"],
    ["bash.bat", "win32", "posix-quoted"],
    ["sh.com", "win32", "posix-quoted"],
    ["C:\\tools/bin\\Fish.exe", "win32", "posix"],
    // Only the last segment counts, and one suffix only at its end.
    ["C:\\bash\\python.exe", "win32", "cmd"],
    ["C:\\pwsh\\cmd.exe", "win32", "cmd"],
    ["C:\\cmd\\bash.exe", "win32", "posix-quoted"],
    ["C:\\wsl\\bash.exe", "win32", "posix-quoted"],
    ["/opt/pwsh/bin/zsh", "linux", "posix"],
    ["bash.exe.bak", "win32", "cmd"],
    ["bash.exe.exe", "win32", "cmd"],
    ["bash.cmd.exe", "win32", "cmd"],
    ["pwsh.exe.cmd", "win32", "cmd"],
    ["pwsh.exe.bak", "win32", "cmd"],
    ["bash.sh", "win32", "cmd"],
    ["exe", "win32", "cmd"],
    [".exe", "win32", "cmd"],
    ["C:\\Program Files\\Git\\bin\\", "win32", "cmd"],
    ["/bin/", "linux", "posix"],
  ])("reads the executable %j on %s as %s", (executable, platform, grammar) => {
    expect(shellGrammar(executable, platform)).toBe(grammar);
  });

  it.each(WIN32_POSIX_SHELLS)(
    "quotes for the sh-family shell %s on Windows",
    (name) => {
      expect(shellGrammar(name, "win32")).toBe("posix-quoted");
      expect(shellGrammar(`${name}.exe`, "win32")).toBe("posix-quoted");
    },
  );

  it.each([...WIN32_POSIX_SHELLS, ...OTHER_SHELLS])(
    "escapes for the POSIX shell %s on macOS",
    (name) => {
      expect(shellGrammar(`/usr/local/bin/${name}`, "darwin")).toBe("posix");
    },
  );

  it.each(OTHER_SHELLS)(
    "escapes for %s on Windows, which reads quotes in its own way",
    (name) => {
      expect(shellGrammar(name, "win32")).toBe("posix");
      expect(shellGrammar(`C:\\tools\\${name}.exe`, "win32")).toBe("posix");
    },
  );

  it("escapes the backslashes of a Windows path for such a shell", () => {
    expect(formatDroppedPath("C:\\Users\\me\\a `b` $c.png", "posix")).toBe(
      "C\\:\\\\Users\\\\me\\\\a\\ \\`b\\`\\ \\$c.png",
    );
  });

  it.each(INTEGRATED_PRESETS)(
    "reads paths as the shell of the %s preset does on %s",
    (key, platform, executable) => {
      expect(shellGrammar(executable, platform)).toBe(PRESET_GRAMMARS[key]);
    },
  );

  it("knows the shell of every integrated preset", () => {
    expect([...new Set(INTEGRATED_PRESETS.map(([key]) => key))].sort()).toEqual(
      Object.keys(PRESET_GRAMMARS).sort(),
    );
  });
});

/**
 * The file names of the `Tricky` folder of the test vault, with the text each
 * grammar writes for them. `<dir>` stands for the directory, and `null` for a
 * path the grammar refuses.
 *
 * A Windows directory holds a part of them only (no `"`, `\`, `*`, `?`, `|`,
 * `<`, `>`, tab or newline in a name), but the functions do not know that.
 */
interface TrickyName extends Readonly<Record<SamePathGrammar, string | null>> {
  readonly name: string;
  /** The text for PowerShell under a POSIX directory, where it is another one. */
  readonly powershellPosix?: string;
}
const TRICKY_NAMES: readonly TrickyName[] = [
  {
    cmd: "<dir>photo.png",
    name: "photo.png",
    posix: "<dir>photo.png",
    "posix-quoted": "'<dir>photo.png'",
    powershell: "<dir>photo.png",
  },
  {
    cmd: '"<dir>photo space.jpg"',
    name: "photo space.jpg",
    posix: "<dir>photo\\ space.jpg",
    "posix-quoted": "'<dir>photo space.jpg'",
    powershell: "'<dir>photo space.jpg'",
  },
  {
    cmd: '"<dir>it\'s a (test) & more.md"',
    name: "it's a (test) & more.md",
    posix: "<dir>it\\'s\\ a\\ \\(test\\)\\ \\&\\ more.md",
    "posix-quoted": '"<dir>it\'s a (test) & more.md"',
    powershell: '"<dir>it\'s a (test) & more.md"',
  },
  {
    cmd: '"<dir>dollar $HOME `tick`.md"',
    name: "dollar $HOME `tick`.md",
    posix: "<dir>dollar\\ \\$HOME\\ \\`tick\\`.md",
    "posix-quoted": "'<dir>dollar $HOME `tick`.md'",
    powershell: "'<dir>dollar $HOME `tick`.md'",
  },
  {
    cmd: '"<dir>semi;colon #hash !bang.md"',
    name: "semi;colon #hash !bang.md",
    posix: "<dir>semi\\;colon\\ \\#hash\\ \\!bang.md",
    "posix-quoted": "'<dir>semi;colon #hash !bang.md'",
    powershell: "'<dir>semi;colon #hash !bang.md'",
  },
  {
    cmd: '"<dir>100% [brackets] {braces} ^caret.png"',
    name: "100% [brackets] {braces} ^caret.png",
    posix: "<dir>100\\%\\ \\[brackets\\]\\ \\{braces\\}\\ \\^caret.png",
    "posix-quoted": "'<dir>100% [brackets] {braces} ^caret.png'",
    powershell: "'<dir>100% [brackets] {braces} ^caret.png'",
  },
  {
    cmd: '"<dir>ünïcødé 日本語 😀.png"',
    name: "ünïcødé 日本語 😀.png",
    posix: "<dir>ünïcødé\\ 日本語\\ 😀.png",
    "posix-quoted": "'<dir>ünïcødé 日本語 😀.png'",
    powershell: "'<dir>ünïcødé 日本語 😀.png'",
  },
  {
    cmd: '"<dir>comma, equals=plus+ at@ tilde~.md"',
    name: "comma, equals=plus+ at@ tilde~.md",
    posix: "<dir>comma\\,\\ equals\\=plus+\\ at@\\ tilde\\~.md",
    "posix-quoted": "'<dir>comma, equals=plus+ at@ tilde~.md'",
    powershell: "'<dir>comma, equals=plus+ at@ tilde~.md'",
  },
  {
    cmd: '"<dir>two  spaces.png"',
    name: "two  spaces.png",
    posix: "<dir>two\\ \\ spaces.png",
    "posix-quoted": "'<dir>two  spaces.png'",
    powershell: "'<dir>two  spaces.png'",
  },
  {
    // `cmd.exe` has no escape for a double quote.
    cmd: null,
    name: 'double "quote".md',
    posix: '<dir>double\\ \\"quote\\".md',
    "posix-quoted": "'<dir>double \"quote\".md'",
    powershell: "'<dir>double \"quote\".md'",
  },
  {
    cmd: "<dir>back\\slash.md",
    name: "back\\slash.md",
    posix: "<dir>back\\\\slash.md",
    "posix-quoted": "'<dir>back\\slash.md'",
    powershell: "<dir>back\\slash.md",
    // There the backslash is part of the name.
    powershellPosix: "'<dir>back\\slash.md'",
  },
  {
    cmd: '"<dir>star* question? pipe| lt< gt>.md"',
    name: "star* question? pipe| lt< gt>.md",
    posix: "<dir>star\\*\\ question\\?\\ pipe\\|\\ lt\\<\\ gt\\>.md",
    "posix-quoted": "'<dir>star* question? pipe| lt< gt>.md'",
    powershell: "'<dir>star* question? pipe| lt< gt>.md'",
  },
  {
    cmd: null,
    // A real tab, not a backslash and a `t`.
    name: "tab\there.md",
    posix: null,
    "posix-quoted": null,
    powershell: null,
  },
  {
    cmd: null,
    // A real newline.
    name: "new\nline.md",
    posix: null,
    "posix-quoted": null,
    powershell: null,
  },
];

/** More names that every grammar writes, for what is read back from them. */
const MORE_NAMES: readonly string[] = [
  "space /before slash.png",
  "My Vault /photo.png",
  "it's /both.png",
  "Plan B: draft.png",
  "Part I: Intro.png",
  "a C:\\shot.png",
  "12:30:15.png",
  "O'Brien.png",
  "\u2018curly\u2019 single.md",
  "\u201ccurly\u201d double.md",
  "low \u201a and \u201e quotes.md",
  "it's $5.md",
  "it's !bang.md",
  "\u2018a\u2019 \u201cb\u201d `c`.md",
  "''.md",
  "Cafe\u0301.png",
  "no\u00a0break.png",
  "-dash.md",
  "~tilde.md",
  "@at.md",
  "trailing space .md",
  "%PATH%.md",
  "!PATH!.md",
];

/**
 * A variable of `cmd.exe` in a name: `%NAME%`, and `!NAME!` with delayed
 * expansion on. Quotes do not keep it from expanding one, so such a name is
 * not among the paths `cmd.exe` reads back, and one with `%NAME%` is not
 * written for it at all.
 */
const CMD_VARIABLE = /%[^%]+%|![^!]+!/u;

const TRICKY_POSIX = "/Users/me/Vault/Tricky/",
  TRICKY_WIN32 = "C:\\Users\\me\\Vault\\Tricky\\";

/** The directories a grammar is used with: PowerShell also runs on macOS and Linux. */
const GRAMMAR_DIRECTORIES: readonly (readonly [SamePathGrammar, string])[] = [
  ["posix", TRICKY_POSIX],
  ["posix-quoted", TRICKY_WIN32],
  ["powershell", TRICKY_WIN32],
  ["powershell", TRICKY_POSIX],
  ["cmd", TRICKY_WIN32],
];

/** The text of a tricky name for a grammar under a directory, `<dir>` filled in. */
function trickyText(
  tricky: TrickyName,
  grammar: SamePathGrammar,
  directory: string,
): string | null {
  const text =
    grammar === "powershell" && directory === TRICKY_POSIX
      ? (tricky.powershellPosix ?? tricky.powershell)
      : tricky[grammar];
  return text?.replace("<dir>", () => directory) ?? null;
}

/** `[grammar, path, expected text]` for every tricky name in every directory of its grammar. */
const TRICKY_CASES: readonly (readonly [
  ShellGrammar,
  string,
  string | null,
])[] = GRAMMAR_DIRECTORIES.flatMap(([grammar, directory]) =>
  TRICKY_NAMES.map((tricky): readonly [ShellGrammar, string, string | null] => [
    grammar,
    directory + tricky.name,
    trickyText(tricky, grammar, directory),
  ]),
);

/** `[grammar, path]` for every path of the tables above that the grammar's shell reads back. */
const WRITTEN_CASES: readonly (readonly [ShellGrammar, string])[] =
  GRAMMAR_DIRECTORIES.flatMap(([grammar, directory]) =>
    [
      ...TRICKY_NAMES.filter((tricky) => tricky[grammar] !== null).map(
        ({ name }) => name,
      ),
      ...MORE_NAMES,
    ]
      .filter((name) => grammar !== "cmd" || !CMD_VARIABLE.test(name))
      .map((name): readonly [ShellGrammar, string] => [
        grammar,
        directory + name,
      ]),
  );

/**
 * The paths of {@link WRITTEN_CASES} for one grammar. WSL has those of
 * `posix`: a Linux path is written as it is, and read back as it was dropped.
 */
function writtenPaths(grammar: ShellGrammar): readonly string[] {
  const fixture = grammar === "wsl" ? "posix" : grammar,
    paths = WRITTEN_CASES.filter(([written]) => written === fixture).map(
      ([, path]) => path,
    );
  if (paths.length === 0) {
    throw new Error(`no paths to write for ${grammar}`);
  }
  return paths;
}

/** `formatDroppedPath` for a path the grammar must be able to write. */
function written(path: string, grammar: ShellGrammar): string {
  const text = formatDroppedPath(path, grammar);
  if (text === null) {
    throw new Error(`${grammar} refused ${JSON.stringify(path)}`);
  }
  return text;
}

/**
 * Splits a line into arguments as a shell does, given the pattern of one
 * argument: `null` where the line is anything but literal arguments.
 */
function shellArguments(
  line: string,
  argument: RegExp,
  unquote: (argument: string) => string,
): readonly string[] | null {
  const read: string[] = [];
  let rest = line.replace(/^ +/u, "");
  while (rest !== "") {
    const [match] = argument.exec(rest) ?? [];
    if (typeof match === "undefined" || match === "") {
      return null;
    }
    read.push(unquote(match));
    rest = rest.slice(match.length).replace(/^ +/u, "");
  }
  return read;
}

/*
 * Reference readers: the arguments each shell makes of a line. They know the
 * quoting rules only, and take a line with a character that the shell may
 * give a meaning to, neither quoted nor escaped, as unreadable.
 */

/**
 * What bash, sh, zsh, dash, ksh, fish and tcsh read alike: a backslash before
 * punctuation is that character. A quote is unreadable, as they do not agree
 * on what quotes keep, and so is a backslash before a letter or a digit, as
 * fish has `\n`.
 */
function escapedArguments(line: string): readonly string[] | null {
  return shellArguments(
    line,
    /^(?:\\[^A-Za-z0-9]|[^ \t\n\\'"$`&|;<>()*?[\]{}~#!^=%,])+(?= |$)/u,
    (argument) => argument.replace(/\\(.)/gsu, "$1"),
  );
}

/**
 * The sh family only (bash, sh, zsh, dash, ksh), not fish, csh or tcsh.
 * Outside quotes a backslash makes the next character literal. Single quotes
 * keep everything. Double quotes keep a backslash too, unless `$`, a
 * backtick, `"` or another backslash follows, which it then escapes; `$`, a
 * backtick and `!` (history) on their own are unreadable there.
 */
function shArguments(line: string): readonly string[] | null {
  return shellArguments(
    line,
    /^(?:\\.|'[^']*'|"(?:[^"\\$`!]|\\.)*"|[^ \t\n\\'"$`&|;<>()*?[\]{}~#!^=%,])+(?= |$)/su,
    (argument) =>
      argument.replace(
        /\\(.)|'([^']*)'|"((?:[^"\\]|\\.)*)"/gsu,
        (
          _match,
          escaped: string | undefined,
          single: string | undefined,
          double: string | undefined,
        ) => escaped ?? single ?? double?.replace(/\\([$`"\\])/gu, "$1") ?? "",
      ),
  );
}

/**
 * PowerShell: a single-quoted string with a pair for each quote inside, a
 * double-quoted string without anything it expands, or a bare word. Curly
 * quotes work as the straight ones do.
 */
function powershellArguments(line: string): readonly string[] | null {
  return shellArguments(
    line,
    /^(?:['\u2018-\u201b](?:[^'\u2018-\u201b]|['\u2018-\u201b]{2})*['\u2018-\u201b]|["\u201c-\u201e][^$`"\u201c-\u201e]*["\u201c-\u201e]|[^\s'\u2018-\u201b"\u201c-\u201e$`(){}[\];,|&<>@#*?=!%^]+)(?= |$)/u,
    (argument) => {
      if (/^['\u2018-\u201b]/u.test(argument)) {
        // Of a pair of quotes, PowerShell keeps the second.
        return argument
          .slice(1, -1)
          .replace(/['\u2018-\u201b](['\u2018-\u201b])/gu, "$1");
      }
      return /^["\u201c-\u201e]/u.test(argument)
        ? argument.slice(1, -1)
        : argument;
    },
  );
}

/**
 * `cmd.exe`, and the program it starts: double quotes, or a bare word.
 * Quotes do not keep `cmd.exe` from expanding a variable (`%NAME%`, and
 * `!NAME!` with delayed expansion on), so a quoted string with one is
 * unreadable.
 *
 * `cmd.exe` escapes nothing inside quotes, but the program that gets the line
 * does when it reads it by the rules of the Microsoft C runtime: before a
 * quote, two backslashes are one, and one more makes the quote a character of
 * the argument. So a quoted string ends after an even number of backslashes
 * only, which are read as half as many; after an odd number the argument
 * would go on into the next one, and the line is unreadable.
 */
function cmdArguments(line: string): readonly string[] | null {
  return shellArguments(
    line,
    /^(?:"(?:(?!%[^%"]+%|![^!"]+!)(?:[^"\\]|\\(?!\\*")))*(?:\\\\)*"|[^\s"&|<>^()%!,;=]+)(?= |$)/u,
    (argument) =>
      argument.startsWith('"')
        ? argument
            .slice(1, -1)
            .replace(/\\+$/u, (run) => run.slice(run.length / 2))
        : argument,
  );
}

const READERS: Readonly<
  Record<ShellGrammar, (line: string) => readonly string[] | null>
> = {
  cmd: cmdArguments,
  posix: escapedArguments,
  "posix-quoted": shArguments,
  powershell: powershellArguments,
  // Whichever shell the distribution starts: the path is escaped for all.
  wsl: escapedArguments,
};

/**
 * Where Claude Code runs. `posix` is macOS and Linux; under `wsl` it is a
 * Linux program that is handed Windows paths.
 */
type ClaudeCodeHost = "posix" | "win32" | "wsl";

/** The names Claude Code looks up as image files. */
const CLAUDE_CODE_IMAGE = /\.(?:png|jpe?g|gif|webp)$/iu;

/**
 * The paths Claude Code makes of one paste, as its 2.1.296 bundle does it.
 * This is the model the tests have of the reader that `dropped-paths.ts`
 * writes for next to the shell; the source only says what it does about it.
 *
 * The paste is cut at each space that is followed by `/` or by a drive (a
 * letter, `:` and a backslash), and at each newline; the cut comes first, so
 * quotes do not prevent it. Each fragment is then trimmed and loses one pair
 * of matching quotes around it. At last the backslash escapes come out: two
 * backslashes are one, any other backslash goes and the character after it
 * stays. A fragment that then ends like an image, is absolute and exists is
 * attached.
 *
 * The escapes stay in on Windows, where a backslash separates (measured with
 * 2.1.292, not read from the bundle), and in a Windows path under WSL, which
 * Claude Code converts to the Linux path itself.
 *
 * What follows from it for the text of a path:
 *
 * - Escaped as a shell needs it, "Plan B: draft.png" is `Plan\ B:\ draft.png`
 *   and gets cut after "Plan": the backslash of the escaped space makes a
 *   drive of ` B:`. Hence a backslash before every colon, and before a slash
 *   after a space, which no shell needs.
 * - Quotes do not keep a path whole, and only one pair comes off. So a path
 *   with a single quote goes in double quotes while the shell allows it: once
 *   the quote is doubled for PowerShell, or written as `'\''` for a shell of
 *   the sh family, the fragment is no longer the path.
 * - On macOS and Linux a backslash is an escape inside quotes too, so a file
 *   with a backslash in its name is not found once PowerShell quotes it.
 * - Several escaped paths in one paste are told apart: each starts with a
 *   slash, and the space that ends the path before it is where the paste is
 *   cut. Several quoted paths are not, as a quote stands between that space
 *   and the slash or the drive. So on Windows, where a path with a space is
 *   quoted, several images are attached only when each path is a paste of its
 *   own.
 */
function claudeCodeReads(
  paste: string,
  host: ClaudeCodeHost,
): readonly string[] {
  return paste
    .split(/ (?=\/|[A-Za-z]:\\)/u)
    .flatMap((fragment) => fragment.split("\n"))
    .filter((fragment) => fragment.trim() !== "")
    .map((fragment) => {
      const trimmed = fragment.trim(),
        unquoted =
          (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
          (trimmed.startsWith("'") && trimmed.endsWith("'"))
            ? trimmed.slice(1, -1)
            : trimmed;
      if (
        host === "win32" ||
        (host === "wsl" && /^(?:[A-Za-z]:\\|\\\\)/u.test(unquoted))
      ) {
        return unquoted;
      }
      // The bundle keeps the place of a pair of backslashes with a random
      // text; U+0000 does here, as no path that is written has one.
      return unquoted
        .replaceAll("\\\\", "\u0000")
        .replace(/\\(.)/gu, "$1")
        .replaceAll("\u0000", "\\");
    });
}

/** The text of one dropped path as it is pasted, with the space after it. */
function pasted(path: string, grammar: ShellGrammar): string {
  const { texts } = formatDroppedPaths([path], grammar),
    [text] = texts;
  if (texts.length !== 1 || typeof text === "undefined") {
    throw new Error(`${grammar} refused ${JSON.stringify(path)}`);
  }
  return text;
}

/**
 * A name as Claude Code looks it up: it reads every pasted path, but only one
 * that ends like an image is a file to it.
 */
function asImage(name: string): string {
  return CLAUDE_CODE_IMAGE.test(name) ? name : `${name}.png`;
}

/** The names of the tables above that a grammar writes, each once. */
function fixtureNames(grammar: SamePathGrammar): readonly string[] {
  return [
    ...new Set([
      ...TRICKY_NAMES.filter((tricky) => tricky[grammar] !== null).map(
        ({ name }) => name,
      ),
      ...MORE_NAMES,
    ]),
  ];
}

/** Names used as path components under an absolute directory. */
const ESCAPED_NAMES: readonly (readonly [string, string, string])[] = [
  ["a plain name", "plain-name_1.0+b@c.png", "plain-name_1.0+b@c.png"],
  ["spaces", "my holiday photo.png", "my\\ holiday\\ photo.png"],
  ["two consecutive spaces", "two  spaces.png", "two\\ \\ spaces.png"],
  // No shell needs these four; Claude Code cuts a paste at ` /` and ` X:\`.
  ["colons", "12:30:15.png", "12\\:30\\:15.png"],
  [
    "a colon after a space and a letter",
    "Plan B: draft.png",
    "Plan\\ B\\:\\ draft.png",
  ],
  [
    "a colon after a space and a capital",
    "Part I: Intro.png",
    "Part\\ I\\:\\ Intro.png",
  ],
  ["a drive after a space", "a C:\\shot.png", "a\\ C\\:\\\\shot.png"],
  ["a single quote", "it's.png", "it\\'s.png"],
  ["double quotes", 'say "hi".png', 'say\\ \\"hi\\".png'],
  ["a backslash", "back\\slash.png", "back\\\\slash.png"],
  ["a variable", "$HOME.png", "\\$HOME.png"],
  ["backticks", "`whoami`.png", "\\`whoami\\`.png"],
  ["parentheses", "copy (1).png", "copy\\ \\(1\\).png"],
  ["an ampersand", "a&b.png", "a\\&b.png"],
  ["a semicolon", "a;b.png", "a\\;b.png"],
  ["a hash", "#tag.png", "\\#tag.png"],
  ["an exclamation mark", "wow!.png", "wow\\!.png"],
  ["a percent sign", "100%.png", "100\\%.png"],
  ["a caret", "a^b.png", "a\\^b.png"],
  ["brackets", "[draft].png", "\\[draft\\].png"],
  ["braces", "{a,b}.png", "\\{a\\,b\\}.png"],
  ["an asterisk", "*.png", "\\*.png"],
  ["a question mark", "what?.png", "what\\?.png"],
  ["a pipe", "a|b.png", "a\\|b.png"],
  ["angle brackets", "<a>.png", "\\<a\\>.png"],
  ["a comma", "a,b.png", "a\\,b.png"],
  ["an equals sign", "a=b.png", "a\\=b.png"],
  ["a tilde", "~backup.png", "\\~backup.png"],
  ["unicode and emoji", "Résumé-日本語-🎉.png", "Résumé-日本語-🎉.png"],
  ["unicode with a space", "été 🎉.png", "été\\ 🎉.png"],
  ["a nested path", "a/b/c/d.png", "a/b/c/d.png"],
  ["a slash after a space", "My Vault /photo.png", "My\\ Vault\\ \\/photo.png"],
  ["a slash after two spaces", "a  /b.png", "a\\ \\ \\/b.png"],
  ["a slash before a space", "a/ b.png", "a/\\ b.png"],
];
const POSIX_DIRECTORY = "/Users/me/vault";

/**
 * Every name that is written for a POSIX shell, as an image, under a plain
 * directory and under one with both places Claude Code cuts at.
 */
const POSIX_IMAGES: readonly string[] = [
  "/Users/me/Vault/Tricky/",
  "/Users/me/My Vault /Plan B: drafts/",
].flatMap((directory) =>
  [
    ...new Set([
      ...fixtureNames("posix"),
      ...ESCAPED_NAMES.map(([, name]) => name),
    ]),
  ].map((name) => directory + asImage(name)),
);

/** The places where Claude Code cuts a paste into several paths. */
const CLAUDE_CODE_CUT = / (?=\/|[A-Za-z]:\\)/u;

/** Every printable ASCII character, U+0020 to U+007E. */
const PRINTABLE_ASCII: readonly string[] = Array.from(
  { length: 0x7f - 0x20 },
  (_, index) => String.fromCharCode(0x20 + index),
);

/**
 * Image names with every printable ASCII character next to a letter, a
 * space, a slash, a colon, a backslash and itself. None ends in a space.
 */
const ASCII_NAMES: readonly string[] = PRINTABLE_ASCII.flatMap((character) => [
  `a${character}b.png`,
  `${character}a.png`,
  `a${character}${character}b.png`,
  `a ${character}b.png`,
  `a${character} b.png`,
  `a/${character}b.png`,
  `a${character}/b.png`,
  `a:${character}b.png`,
  `a${character}:b.png`,
  `a\\${character}b.png`,
  `a${character}\\b.png`,
  `a ${character}:\\b.png`,
]);

/** Paths no grammar may write: they would send control input to the program. */
const CONTROL_PATHS: readonly (readonly [string, string])[] = [
  ["a newline", "/vault/new\nline.png"],
  ["a carriage return", "/vault/carriage\rreturn.png"],
  ["a tab", "/vault/tab\t.png"],
  ["an escape", "/vault/\u001b[31mred.png"],
  ["a NUL", "/vault/nul\u0000.png"],
  ["a unit separator", "/vault/unit\u001fseparator.png"],
  ["a DEL", "/vault/del\u007f.png"],
  // C1 control characters: xterm.js runs them when a shell echoes them raw.
  ["the first C1 control character", "/vault/pad\u0080.png"],
  ["a next line", "/vault/next\u0085line.png"],
  // U+009B is `ESC [` in one character: this name asks for the cursor position.
  ["a control sequence introducer", "/vault/a\u009b6nb.png"],
  ["the last C1 control character", "/vault/apc\u009f.png"],
];

describe("formatDroppedPath", () => {
  it.each(TRICKY_CASES)("writes for %s the path %j", (grammar, path, text) => {
    expect(formatDroppedPath(path, grammar)).toBe(text);
  });

  it.each(WRITTEN_CASES)(
    "gives the %s shell one argument that is the path %j",
    (grammar, path) => {
      expect(READERS[grammar](written(path, grammar))).toEqual([path]);
    },
  );

  it.each(GRAMMARS)("refuses an empty path for %s", (grammar) => {
    expect(formatDroppedPath("", grammar)).toBeNull();
  });

  it.each(
    GRAMMARS.flatMap((grammar) =>
      CONTROL_PATHS.map(
        ([name, path]): readonly [ShellGrammar, string, string] => [
          grammar,
          name,
          path,
        ],
      ),
    ),
  )("refuses for %s a path with %s", (grammar, _name, path) => {
    expect(formatDroppedPath(path, grammar)).toBeNull();
  });

  it.each(GRAMMARS)(
    "writes for %s a path with the characters next to the control ranges",
    (grammar) => {
      // U+007E is the last character before DEL, U+00A0 the first after C1.
      const path = "/vault/a~b\u00a0c.png";

      expect(READERS[grammar](written(path, grammar))).toEqual([path]);
    },
  );

  describe("for a POSIX shell", () => {
    it.each(ESCAPED_NAMES)("escapes %s", (_name, name, escaped) => {
      expect(formatDroppedPath(`${POSIX_DIRECTORY}/${name}`, "posix")).toBe(
        `${POSIX_DIRECTORY}/${escaped}`,
      );
    });

    it("escapes every special character in a directory name too", () => {
      expect(formatDroppedPath("/Users/me/My Vault (old)/a.png", "posix")).toBe(
        "/Users/me/My\\ Vault\\ \\(old\\)/a.png",
      );
    });

    it("keeps a no-break space, which no shell splits at, as it is", () => {
      expect(formatDroppedPath("/vault/a\u00a0b.png", "posix")).toBe(
        "/vault/a\u00a0b.png",
      );
    });

    it("keeps a decomposed accent as it is", () => {
      expect(formatDroppedPath("/vault/Cafe\u0301.png", "posix")).toBe(
        "/vault/Cafe\u0301.png",
      );
    });

    it.each(ESCAPED_NAMES)(
      "gives Claude Code one path, the one with %s",
      (_name, name) => {
        const path = `${POSIX_DIRECTORY}/${name}`;

        expect(claudeCodeReads(pasted(path, "posix"), "posix")).toEqual([path]);
      },
    );

    it.each(ESCAPED_NAMES)(
      "leaves no unescaped space in the path with %s",
      (_name, name) => {
        // A space separates arguments only where no backslash escapes it, so
        // none may be left once the escape pairs are taken out.
        const unescaped = written(
          `${POSIX_DIRECTORY}/${name}`,
          "posix",
        ).replace(/\\./gu, "");

        expect(unescaped).not.toContain(" ");
      },
    );

    it.each<readonly [string, string, string]>([
      [
        "a file name",
        "/Users/me/Vault/a /b.png",
        "/Users/me/Vault/a\\ \\/b.png",
      ],
      [
        "a directory name",
        "/Users/me/My Vault /Tricky/photo space.jpg",
        "/Users/me/My\\ Vault\\ \\/Tricky/photo\\ space.jpg",
      ],
      [
        "a path with a single quote",
        "/Users/me/it's /b.png",
        "/Users/me/it\\'s\\ \\/b.png",
      ],
      [
        "a path with a dollar sign and a backslash",
        "/Users/me/$HOME /back\\slash.png",
        "/Users/me/\\$HOME\\ \\/back\\\\slash.png",
      ],
      [
        "a path with several of them",
        "/Users/me/a /b /c.png",
        "/Users/me/a\\ \\/b\\ \\/c.png",
      ],
    ])(
      "escapes the slash after a space in %s, where Claude Code would cut the path",
      (_name, path, text) => {
        expect(formatDroppedPath(path, "posix")).toBe(text);
        expect(READERS.posix(text)).toEqual([path]);
        expect(claudeCodeReads(`${text} `, "posix")).toEqual([path]);
      },
    );

    it("leaves the first slash of a path as it is", () => {
      expect(formatDroppedPath("/a.png", "posix")).toBe("/a.png");
    });

    it.each(writtenPaths("posix"))("never quotes %j", (path) => {
      // fish and tcsh do not read quotes as sh does, and no quote keeps
      // Claude Code from cutting a path.
      expect(written(path, "posix").replace(/\\./gu, "")).not.toMatch(/['"]/u);
    });

    it.each(writtenPaths("posix"))(
      "leaves Claude Code no place to cut %j at",
      (path) => {
        expect(written(path, "posix")).not.toMatch(CLAUDE_CODE_CUT);
      },
    );

    it("writes every printable ASCII character so that the shells and Claude Code read it back", () => {
      const unreadable = ASCII_NAMES.map(
        (name) => `${POSIX_DIRECTORY}/${name}`,
      ).filter((path) => {
        const text = pasted(path, "posix"),
          [shell, ...more] = READERS.posix(text) ?? [],
          [claudeCode, ...fragments] = claudeCodeReads(text, "posix");
        return !(
          shell === path &&
          more.length === 0 &&
          claudeCode === path &&
          fragments.length === 0 &&
          !CLAUDE_CODE_CUT.test(text)
        );
      });

      expect(unreadable).toEqual([]);
    });
  });

  describe("for a shell of the sh family on Windows", () => {
    it.each<readonly [string, string, string]>([
      ["a plain path", "C:\\Users\\me\\a.png", "'C:\\Users\\me\\a.png'"],
      ["forward slashes", "C:/Users/me/a.png", "'C:/Users/me/a.png'"],
      ["a space", "C:\\Users\\a b\\c.png", "'C:\\Users\\a b\\c.png'"],
      [
        "everything double quotes would change, but no single quote",
        'C:\\Users\\$HOME `x` "y" !z\\\\w\\',
        "'C:\\Users\\$HOME `x` \"y\" !z\\\\w\\'",
      ],
      ["a drive root", "C:\\", "'C:\\'"],
    ])("single-quotes %s", (_name, path, text) => {
      expect(formatDroppedPath(path, "posix-quoted")).toBe(text);
      expect(READERS["posix-quoted"](text)).toEqual([path]);
      expect(claudeCodeReads(`${text} `, "win32")).toEqual([path]);
    });

    it.each<readonly [string, string, string]>([
      [
        "a single quote",
        "C:\\Users\\O'Brien\\a.png",
        '"C:\\Users\\O\'Brien\\a.png"',
      ],
      [
        "a single quote and a space",
        "C:\\Users\\O'Brien\\my photo.png",
        '"C:\\Users\\O\'Brien\\my photo.png"',
      ],
      [
        "two single quotes in a row",
        "C:\\Users\\''.png",
        "\"C:\\Users\\''.png\"",
      ],
      [
        "a single quote right after a backslash",
        "C:\\Users\\'quoted'.png",
        "\"C:\\Users\\'quoted'.png\"",
      ],
      [
        "a single quote and forward slashes",
        "C:/Users/O'Brien/a.png",
        '"C:/Users/O\'Brien/a.png"',
      ],
      [
        "a single quote and what only other shells expand",
        "C:\\Users\\O'Brien\\100% #1 & (a) [b] {c} ~d ^e;f.png",
        '"C:\\Users\\O\'Brien\\100% #1 & (a) [b] {c} ~d ^e;f.png"',
      ],
    ])(
      "double-quotes a path with %s, so that Claude Code still reads it",
      (_name, path, text) => {
        expect(formatDroppedPath(path, "posix-quoted")).toBe(text);
        expect(READERS["posix-quoted"](text)).toEqual([path]);
        expect(claudeCodeReads(`${text} `, "win32")).toEqual([path]);
      },
    );

    // Known limit. Only single quotes keep these characters as they are, and
    // a single quote inside them takes four characters that Claude Code does
    // not take out again: it shows the text instead of attaching the file.
    it.each<readonly [string, string, string, string]>([
      [
        "a dollar sign",
        "C:\\Users\\O'Brien\\$5.png",
        "'C:\\Users\\O'\\''Brien\\$5.png'",
        "C:\\Users\\O'\\''Brien\\$5.png",
      ],
      [
        "a backtick",
        "C:\\Users\\O'Brien\\`a`.png",
        "'C:\\Users\\O'\\''Brien\\`a`.png'",
        "C:\\Users\\O'\\''Brien\\`a`.png",
      ],
      [
        "a double quote",
        'C:\\Users\\O\'Brien\\"a".png',
        "'C:\\Users\\O'\\''Brien\\\"a\".png'",
        "C:\\Users\\O'\\''Brien\\\"a\".png",
      ],
      [
        "an exclamation mark, which bash and zsh take for history",
        "C:\\Users\\O'Brien\\wow!.png",
        "'C:\\Users\\O'\\''Brien\\wow!.png'",
        "C:\\Users\\O'\\''Brien\\wow!.png",
      ],
      [
        "two backslashes in a row, which double quotes read as one",
        "C:\\Users\\\\O'Brien.png",
        "'C:\\Users\\\\O'\\''Brien.png'",
        "C:\\Users\\\\O'\\''Brien.png",
      ],
      [
        "a backslash at the end, which would escape the closing quote",
        "C:\\Users\\O'Brien\\",
        "'C:\\Users\\O'\\''Brien\\'",
        "C:\\Users\\O'\\''Brien\\",
      ],
    ])(
      "single-quotes a path with a single quote and %s, which Claude Code no longer reads",
      (_name, path, text, read) => {
        expect(formatDroppedPath(path, "posix-quoted")).toBe(text);
        expect(READERS["posix-quoted"](text)).toEqual([path]);
        expect(claudeCodeReads(`${text} `, "win32")).toEqual([read]);
      },
    );

    // Known limit, of no consequence: Claude Code cuts a paste before it
    // looks at quotes, so none keeps this path whole, and Windows has no name
    // that ends in a space.
    it("cannot keep Claude Code from cutting a path at a space before a slash", () => {
      const path = "C:/Users/a /b.png",
        text = "'C:/Users/a /b.png'";

      expect(formatDroppedPath(path, "posix-quoted")).toBe(text);
      expect(READERS["posix-quoted"](text)).toEqual([path]);
      expect(claudeCodeReads(`${text} `, "win32")).toEqual([
        "'C:/Users/a",
        "/b.png'",
      ]);
    });
  });

  describe("for the Linux shell of WSL", () => {
    const linuxDirectory = "/mnt/c/Users/me/Vault/Tricky/",
      // A backslash is a separator in a Windows path, not a part of a name.
      names = fixtureNames("posix").filter((name) => !name.includes("\\"));

    it.each<readonly [string, string, string, string]>([
      [
        "a file on a drive",
        "C:\\Users\\me\\a.png",
        "/mnt/c/Users/me/a.png",
        "/mnt/c/Users/me/a.png",
      ],
      [
        "a drive written in lower case",
        "d:\\data\\a.png",
        "/mnt/d/data/a.png",
        "/mnt/d/data/a.png",
      ],
      [
        "forward slashes",
        "C:/Users/me/a.png",
        "/mnt/c/Users/me/a.png",
        "/mnt/c/Users/me/a.png",
      ],
      [
        "a space",
        "C:\\Users\\a b\\c d.png",
        "/mnt/c/Users/a\\ b/c\\ d.png",
        "/mnt/c/Users/a b/c d.png",
      ],
      [
        "what a shell expands",
        "C:\\Users\\$HOME `x` & (y);z.png",
        "/mnt/c/Users/\\$HOME\\ \\`x\\`\\ \\&\\ \\(y\\)\\;z.png",
        "/mnt/c/Users/$HOME `x` & (y);z.png",
      ],
      [
        "a single quote",
        "C:\\Users\\O'Brien\\a.png",
        "/mnt/c/Users/O\\'Brien/a.png",
        "/mnt/c/Users/O'Brien/a.png",
      ],
      ["a drive root", "C:\\", "/mnt/c/", "/mnt/c/"],
      [
        "a folder with a backslash at its end",
        "C:\\Users\\me\\",
        "/mnt/c/Users/me/",
        "/mnt/c/Users/me/",
      ],
      [
        "a file of a distribution",
        "\\\\wsl.localhost\\Ubuntu\\home\\me\\a b.png",
        "/home/me/a\\ b.png",
        "/home/me/a b.png",
      ],
      [
        "a file of a distribution under the older name of the share",
        "\\\\wsl$\\Ubuntu-24.04\\home\\me\\a.png",
        "/home/me/a.png",
        "/home/me/a.png",
      ],
      [
        "a file of a distribution in another case and with forward slashes",
        "//WSL.LOCALHOST/Ubuntu/etc/hosts",
        "/etc/hosts",
        "/etc/hosts",
      ],
      ["the root of a distribution", "\\\\wsl.localhost\\Ubuntu", "/", "/"],
      [
        "the root of a distribution with a backslash at its end",
        "\\\\wsl$\\Ubuntu\\",
        "/",
        "/",
      ],
      [
        "a path that is a Linux one already",
        "/home/me/a b.png",
        "/home/me/a\\ b.png",
        "/home/me/a b.png",
      ],
    ])("writes %s as its Linux path", (_name, path, text, linux) => {
      expect(formatDroppedPath(path, "wsl")).toBe(text);
      expect(READERS.wsl(text)).toEqual([linux]);
      expect(claudeCodeReads(`${text} `, "wsl")).toEqual([linux]);
    });

    // Windows allows the line and paragraph separators of Unicode in a name,
    // and they are no control characters: such a path is not refused.
    it.each([
      [
        "under a drive",
        "C:\\Users\\me\\a\u2028b\u2029c.png",
        "/mnt/c/Users/me/a\u2028b\u2029c.png",
      ],
      [
        "in a distribution",
        "\\\\wsl.localhost\\Ubuntu\\home\\me\\a\u2028b\u2029c.png",
        "/home/me/a\u2028b\u2029c.png",
      ],
    ])(
      "keeps a name with a line separator of Unicode %s whole",
      (_name, path, linux) => {
        expect(formatDroppedPath(path, "wsl")).toBe(linux);
        expect(READERS.wsl(linux)).toEqual([linux]);
      },
    );

    it.each<readonly [string, string]>([
      ["a network share", "\\\\server\\share\\a.png"],
      ["a network share with forward slashes", "//server/share/a.png"],
      [
        "a host whose name only starts like the one of WSL",
        "\\\\wsl.localhost.example\\Ubuntu\\a.png",
      ],
      ["the host of WSL without a distribution", "\\\\wsl.localhost\\"],
      ["a device path", "\\\\?\\C:\\Users\\me\\a.png"],
      ["a path relative to a drive", "C:a.png"],
      ["a path relative to the current drive", "\\Users\\me\\a.png"],
      ["a relative path", "a.png"],
    ])("refuses %s, which has no place under WSL", (_name, path) => {
      expect(formatDroppedPath(path, "wsl")).toBeNull();
    });

    it.each([...TRICKY_NAMES.map(({ name }) => name), ...MORE_NAMES])(
      "writes %j under a drive as a POSIX shell gets its Linux path",
      (name) => {
        expect(formatDroppedPath(TRICKY_WIN32 + name, "wsl")).toBe(
          formatDroppedPath(
            linuxDirectory + name.replaceAll("\\", "/"),
            "posix",
          ),
        );
      },
    );

    it.each(names)(
      "gives the Linux shell one argument that is the Linux path of %j",
      (name) => {
        expect(READERS.wsl(written(TRICKY_WIN32 + name, "wsl"))).toEqual([
          linuxDirectory + name,
        ]);
      },
    );

    // Claude Code is the Linux program there: it reads the escapes as on
    // Linux, and would convert a Windows path itself, which it no longer gets.
    it.each(names.map(asImage))(
      "is the one image path Claude Code reads under WSL for %j",
      (name) => {
        expect(
          claudeCodeReads(pasted(TRICKY_WIN32 + name, "wsl"), "wsl"),
        ).toEqual([linuxDirectory + name]);
      },
    );

    it("gives the terminal of the WSL preset the Linux path, not the Windows one", () => {
      const path = "C:\\Users\\me\\My Vault\\photo.png",
        linux = "/mnt/c/Users/me/My Vault/photo.png",
        grammar = shellGrammar("C:\\Windows\\System32\\wsl.exe", "win32"),
        text = pasted(path, grammar);

      expect(grammar).toBe("wsl");
      expect(text).toBe("/mnt/c/Users/me/My\\ Vault/photo.png ");
      expect(READERS[grammar](text)).toEqual([linux]);
      expect(claudeCodeReads(text, "wsl")).toEqual([linux]);
    });

    it("writes several paths, each a paste of its own, and skips one on a network share", () => {
      const { skipped, texts } = formatDroppedPaths(
          [
            "C:\\Users\\me\\My Vault\\a.png",
            "\\\\server\\share\\b.png",
            "D:\\c d.png",
            "\\\\wsl.localhost\\Ubuntu\\home\\me\\e.png",
          ],
          "wsl",
        ),
        linux = [
          "/mnt/c/Users/me/My Vault/a.png",
          "/mnt/d/c d.png",
          "/home/me/e.png",
        ],
        pastes = droppedPathPastes(texts, "win32");

      expect(skipped).toBe(1);
      expect(texts).toEqual([
        "/mnt/c/Users/me/My\\ Vault/a.png ",
        "/mnt/d/c\\ d.png ",
        "/home/me/e.png ",
      ]);
      expect(pastes).toEqual(texts);
      expect(READERS.wsl(pastes.join(""))).toEqual(linux);
      expect(pastes.flatMap((paste) => claudeCodeReads(paste, "wsl"))).toEqual(
        linux,
      );
    });

    // Known limit. The executable of a profile does not tell which
    // distribution the terminal runs, so a file of any distribution is
    // written as one of this distribution.
    it("takes a file of any distribution for one of the distribution of the terminal", () => {
      expect(
        formatDroppedPath("\\\\wsl.localhost\\Debian\\home\\me\\a.png", "wsl"),
      ).toBe("/home/me/a.png");
    });
  });

  describe("for PowerShell", () => {
    it.each<readonly [string, string, string]>([
      ["a plain path", "C:\\Users\\a\\b.png", "C:\\Users\\a\\b.png"],
      ["forward slashes", "C:/Users/a/b.png", "C:/Users/a/b.png"],
      ["a POSIX path", "/Users/me/a-b_c.png", "/Users/me/a-b_c.png"],
      [
        "letters and digits of any script",
        "C:\\Users\\a\\日本語-ünï-٣.png",
        "C:\\Users\\a\\日本語-ünï-٣.png",
      ],
      [
        "a decomposed accent",
        "C:\\Users\\a\\Cafe\u0301.png",
        "C:\\Users\\a\\Cafe\u0301.png",
      ],
      [
        "a tilde and a plus",
        "C:\\Users\\a~1\\b+c.png",
        "C:\\Users\\a~1\\b+c.png",
      ],
      // Without quotes, a backslash at the end escapes nothing.
      ["a drive root", "C:\\", "C:\\"],
      ["a backslash at the end", "C:\\Users\\a\\", "C:\\Users\\a\\"],
      ["a share", "\\\\server\\share\\", "\\\\server\\share\\"],
    ])("leaves %s without quotes", (_name, path, text) => {
      expect(formatDroppedPath(path, "powershell")).toBe(text);
    });

    it.each<readonly [string, string, string]>([
      ["in a name", "/Users/me/back\\slash.png", "'/Users/me/back\\slash.png'"],
      ["at the end", "/Users/me/folder\\", "'/Users/me/folder\\'"],
      ["at the end, after a space", "/Users/me/a b\\", "'/Users/me/a b\\'"],
      [
        "and a single quote",
        "/Users/me/it's\\here.png",
        '"/Users/me/it\'s\\here.png"',
      ],
    ])(
      "quotes a POSIX path with a backslash %s, which is part of the name there",
      (_name, path, text) => {
        expect(formatDroppedPath(path, "powershell")).toBe(text);
        expect(READERS.powershell(text)).toEqual([path]);
      },
    );

    it.each<readonly [string, string, string, string]>([
      [
        "a folder",
        "C:\\Users\\My Vault\\",
        "'C:\\Users\\My Vault'",
        "C:\\Users\\My Vault",
      ],
      [
        "a folder with a single quote",
        "C:\\Users\\it's\\",
        '"C:\\Users\\it\'s"',
        "C:\\Users\\it's",
      ],
      [
        "a folder with a single quote and a dollar sign",
        "C:\\Users\\it's $5\\",
        "'C:\\Users\\it''s $5'",
        "C:\\Users\\it's $5",
      ],
      [
        "a folder with two backslashes at the end",
        "C:\\Users\\My Vault\\\\",
        "'C:\\Users\\My Vault'",
        "C:\\Users\\My Vault",
      ],
      [
        "a share",
        "\\\\server\\my share\\",
        "'\\\\server\\my share'",
        "\\\\server\\my share",
      ],
    ])(
      "takes the backslash off the end of %s that it quotes",
      (_name, path, text, read) => {
        // A program that reads its command line as the Microsoft C runtime
        // does would take `\"` for an escaped quote.
        expect(formatDroppedPath(path, "powershell")).toBe(text);
        expect(READERS.powershell(text)).toEqual([read]);
      },
    );

    it("keeps the backslash of a root that it quotes", () => {
      // `\\?\C:` is the volume, not its root folder.
      expect(formatDroppedPath("\\\\?\\C:\\", "powershell")).toBe(
        "'\\\\?\\C:\\'",
      );
    });

    it("writes the backslash of a root twice in double quotes", () => {
      // Alone before the quote it would escape it for a program that reads
      // its command line as the Microsoft C runtime does. PowerShell itself
      // escapes nothing with a backslash, and keeps both.
      expect(formatDroppedPath("\\\\?\\it's:\\", "powershell")).toBe(
        '"\\\\?\\it\'s:\\\\"',
      );
    });

    it("leaves a backslash at the end of a POSIX path alone in double quotes", () => {
      // There it is a character of the name, and no command line is parsed.
      expect(formatDroppedPath("/Users/me/it's\\", "powershell")).toBe(
        '"/Users/me/it\'s\\"',
      );
    });

    it.each<readonly [string, string, string]>([
      ["a space", "C:\\Users\\a b\\c.png", "'C:\\Users\\a b\\c.png'"],
      ["an emoji", "C:\\Users\\a\\🎉.png", "'C:\\Users\\a\\🎉.png'"],
      ["an at sign", "C:\\Users\\a@b.png", "'C:\\Users\\a@b.png'"],
      [
        "a no-break space, which PowerShell splits at",
        "C:\\Users\\a\u00a0b.png",
        "'C:\\Users\\a\u00a0b.png'",
      ],
      ["a dollar sign", "C:\\Users\\$HOME.png", "'C:\\Users\\$HOME.png'"],
      ["a backtick", "C:\\Users\\a`b.png", "'C:\\Users\\a`b.png'"],
      ["a double quote", '/Users/me/a"b.png', "'/Users/me/a\"b.png'"],
      [
        "a left curly double quote",
        "C:\\Users\\a\u201cb.png",
        "'C:\\Users\\a\u201cb.png'",
      ],
      [
        "a right curly double quote",
        "C:\\Users\\a\u201db.png",
        "'C:\\Users\\a\u201db.png'",
      ],
      [
        "a low double quote",
        "C:\\Users\\a\u201eb.png",
        "'C:\\Users\\a\u201eb.png'",
      ],
    ])("single-quotes a path with %s", (_name, path, text) => {
      expect(formatDroppedPath(path, "powershell")).toBe(text);
    });

    it.each<readonly [string, string, string]>([
      ["a single quote", "C:\\Users\\it's.png", '"C:\\Users\\it\'s.png"'],
      [
        "a left curly single quote",
        "C:\\Users\\a\u2018b.png",
        '"C:\\Users\\a\u2018b.png"',
      ],
      [
        "a right curly single quote",
        "C:\\Users\\it\u2019s.png",
        '"C:\\Users\\it\u2019s.png"',
      ],
      [
        "a low single quote",
        "C:\\Users\\a\u201ab.png",
        '"C:\\Users\\a\u201ab.png"',
      ],
      [
        "a reversed single quote",
        "C:\\Users\\a\u201bb.png",
        '"C:\\Users\\a\u201bb.png"',
      ],
    ])(
      "double-quotes a path with %s, so that Claude Code still reads it",
      (_name, path, text) => {
        expect(formatDroppedPath(path, "powershell")).toBe(text);
      },
    );

    it.each<readonly [string, string, string]>([
      [
        "a single quote and a dollar sign",
        "C:\\Users\\it's $5.png",
        "'C:\\Users\\it''s $5.png'",
      ],
      [
        "a single quote and a backtick",
        "C:\\Users\\it's `b`.png",
        "'C:\\Users\\it''s `b`.png'",
      ],
      [
        "a single and a double quote",
        '/Users/me/it\'s "b".png',
        "'/Users/me/it''s \"b\".png'",
      ],
      [
        "curly single and curly double quotes",
        "C:\\Users\\\u2018a\u2019 \u201cb\u201d.png",
        "'C:\\Users\\\u2018\u2018a\u2019\u2019 \u201cb\u201d.png'",
      ],
      [
        "every single quote PowerShell knows and a dollar sign",
        "C:\\Users\\'\u2018\u2019\u201a\u201b$.png",
        "'C:\\Users\\''\u2018\u2018\u2019\u2019\u201a\u201a\u201b\u201b$.png'",
      ],
    ])(
      "single-quotes a path with %s, doubling each single quote",
      (_name, path, text) => {
        expect(formatDroppedPath(path, "powershell")).toBe(text);
      },
    );
  });

  describe("for cmd.exe", () => {
    it.each<readonly [string, string, string]>([
      ["a plain path", "C:\\Users\\a\\b.png", "C:\\Users\\a\\b.png"],
      ["forward slashes", "C:/Users/a/b.png", "C:/Users/a/b.png"],
      [
        "letters of any script",
        "C:\\Users\\a\\日本語-ünï.png",
        "C:\\Users\\a\\日本語-ünï.png",
      ],
      // Without quotes, a backslash at the end escapes nothing.
      ["a drive root", "C:\\", "C:\\"],
      ["a backslash at the end", "C:\\Users\\a\\", "C:\\Users\\a\\"],
      ["a share", "\\\\server\\share\\", "\\\\server\\share\\"],
    ])("leaves %s without quotes", (_name, path, text) => {
      expect(formatDroppedPath(path, "cmd")).toBe(text);
    });

    it.each<readonly [string, string, string, string]>([
      [
        "a folder",
        "C:\\Users\\My Vault\\",
        '"C:\\Users\\My Vault"',
        "C:\\Users\\My Vault",
      ],
      [
        "a folder with two backslashes at the end",
        "C:\\Users\\My Vault\\\\",
        '"C:\\Users\\My Vault"',
        "C:\\Users\\My Vault",
      ],
      [
        "a folder with a single quote",
        "C:\\Users\\it's\\",
        '"C:\\Users\\it\'s"',
        "C:\\Users\\it's",
      ],
      [
        "a share",
        "\\\\server\\my share\\",
        '"\\\\server\\my share"',
        "\\\\server\\my share",
      ],
    ])(
      "takes the backslash off the end of %s that it quotes",
      (_name, path, text, read) => {
        // A program that reads its command line as the Microsoft C runtime
        // does would take `\"` for an escaped quote.
        expect(formatDroppedPath(path, "cmd")).toBe(text);
        expect(READERS.cmd(text)).toEqual([read]);
        expect(claudeCodeReads(`${text} `, "win32")).toEqual([read]);
      },
    );

    it("writes the backslash of a root that it quotes twice", () => {
      // `\\?\C:` is the volume, not its root folder, so the backslash stays.
      // Alone before the quote it would escape it for a program that reads
      // its command line as the Microsoft C runtime does.
      const root = "\\\\?\\C:\\",
        text = written(root, "cmd");

      expect(text).toBe('"\\\\?\\C:\\\\"');
      expect(READERS.cmd(text)).toEqual([root]);
    });

    it("keeps the path dropped after a quoted root an argument of its own", () => {
      const paths = ["\\\\?\\C:\\", "C:\\Users\\My Vault\\a.png"],
        { texts } = formatDroppedPaths(paths, "cmd");

      expect(texts.join("")).toBe(
        '"\\\\?\\C:\\\\" "C:\\Users\\My Vault\\a.png" ',
      );
      expect(READERS.cmd(texts.join(""))).toEqual(paths);
      // With one backslash before the quote, the first argument has no end.
      expect(
        READERS.cmd('"\\\\?\\C:\\" "C:\\Users\\My Vault\\a.png" '),
      ).toBeNull();
    });

    it("writes every backslash a quoted root ends in twice", () => {
      const root = "C:\\My Vault:\\\\",
        text = written(root, "cmd");

      expect(text).toBe('"C:\\My Vault:\\\\\\\\"');
      expect(READERS.cmd(text)).toEqual([root]);
    });

    // `cmd.exe` expands `%NAME%` before it reads quotes, so a value that
    // holds a double quote ends the quoted string, and an `&` after it starts
    // a command. The ConHost launcher gives every shell such a variable (`q`).
    // `cmd.exe` has no way to write a `%NAME%` that it leaves alone.
    it.each<readonly [string, string]>([
      [
        "the quote variable of the ConHost launcher",
        "C:\\drop\\%q%&echo INJECTED&rem .txt",
      ],
      ["that variable in upper case", "C:\\drop\\%Q%&echo INJECTED&rem .txt"],
      ["%NAME%", "C:\\Users\\me\\%PATH%.md"],
      [
        "%NAME% with spaces around it",
        "C:\\Users\\me\\old %USERPROFILE% copy.md",
      ],
      ["a variable that cmd.exe computes", "C:\\Users\\me\\%CMDCMDLINE%.md"],
      ["two percent signs with text between", "C:\\Users\\me\\5% of 10%.md"],
    ])("refuses a path with %s, which cmd.exe would expand", (_name, path) => {
      expect(formatDroppedPath(path, "cmd")).toBeNull();
      // The other paths of the drop are still written.
      expect(formatDroppedPaths([path, "C:\\c d.png"], "cmd")).toEqual({
        skipped: 1,
        texts: ['"C:\\c d.png" '],
      });
    });

    it("writes a path with %NAME% for the shells that do not expand it", () => {
      const path = "C:\\drop\\%q%&echo INJECTED&rem .txt";

      expect(formatDroppedPath(path, "powershell")).toBe(`'${path}'`);
      expect(formatDroppedPath(path, "posix-quoted")).toBe(`'${path}'`);
    });

    // Known limit. With delayed expansion on (`cmd /V:ON`), `cmd.exe` expands
    // `!NAME!` inside double quotes as well: the program gets the value in
    // place of the name. That happens once the line is split, so the value
    // cannot end the quotes, and delayed expansion is off unless asked for.
    it("double-quotes a path with !NAME!, which cmd.exe expands with delayed expansion on", () => {
      const path = "C:\\Users\\me\\!PATH!.md",
        text = '"C:\\Users\\me\\!PATH!.md"';

      expect(formatDroppedPath(path, "cmd")).toBe(text);
      expect(READERS.cmd(text)).toBeNull();
      // Claude Code does not expand anything.
      expect(claudeCodeReads(`${text} `, "win32")).toEqual([path]);
    });

    it.each<readonly [string, string]>([
      ["a percent sign", "C:\\Users\\me\\100% done.md"],
      ["an exclamation mark", "C:\\Users\\me\\wow!.md"],
      ["a percent sign and an exclamation mark", "C:\\Users\\me\\100% !.md"],
    ])("gives cmd.exe a path with only %s as it is", (_name, path) => {
      // As measured in a `cmd.exe` that was just started. With delayed
      // expansion on, it drops a lone `!` as well.
      expect(READERS.cmd(written(path, "cmd"))).toEqual([path]);
    });

    it.each<readonly [string, string, string]>([
      ["a space", "C:\\Users\\a b\\c.png", '"C:\\Users\\a b\\c.png"'],
      ["an ampersand", "C:\\Users\\a&b.png", '"C:\\Users\\a&b.png"'],
      ["parentheses", "C:\\Users\\copy(1).png", '"C:\\Users\\copy(1).png"'],
      ["a single quote", "C:\\Users\\it's.png", '"C:\\Users\\it\'s.png"'],
      ["an emoji", "C:\\Users\\a\\🎉.png", '"C:\\Users\\a\\🎉.png"'],
      ["a caret", "C:\\Users\\a^b.png", '"C:\\Users\\a^b.png"'],
      ["a percent sign", "C:\\Users\\100%.png", '"C:\\Users\\100%.png"'],
      [
        "curly quotes, which mean nothing to it",
        "C:\\Users\\\u2018a\u2019 \u201cb\u201d.png",
        '"C:\\Users\\\u2018a\u2019 \u201cb\u201d.png"',
      ],
    ])("double-quotes a path with %s", (_name, path, text) => {
      expect(formatDroppedPath(path, "cmd")).toBe(text);
    });

    it.each<readonly [string, string]>([
      ["in a name", 'C:\\Users\\a"b.png'],
      ["at the start", '"C:\\Users\\a.png'],
      ["around the path", '"C:\\Users\\a b.png"'],
    ])("refuses a path with a double quote %s", (_name, path) => {
      expect(formatDroppedPath(path, "cmd")).toBeNull();
    });
  });

  describe("read by Claude Code", () => {
    /**
     * Every fixture name as an image under a Windows directory, but for the
     * paths Claude Code cuts whatever is written around them. Windows has
     * none of those: no name there ends in a space or holds a colon.
     */
    const windowsImages = (grammar: SamePathGrammar): readonly string[] =>
        fixtureNames(grammar)
          .map((name) => TRICKY_WIN32 + asImage(name))
          .filter((path) => !CLAUDE_CODE_CUT.test(path)),
      // Only single quotes hold these for a shell of the sh family...
      shSingleQuoted = (path: string): boolean =>
        path.includes("'") && /[$`"!]|\\\\|\\$/u.test(path),
      // ...and these for PowerShell, each with its single quotes rewritten.
      powershellDoubled = (path: string): boolean =>
        /['\u2018-\u201b]/u.test(path) && /[$`"\u201c-\u201e]/u.test(path);

    it.each(POSIX_IMAGES)(
      "is the one image path %j once escaped for a POSIX shell",
      (path) => {
        expect(claudeCodeReads(pasted(path, "posix"), "posix")).toEqual([path]);
      },
    );

    // Known limit, the only one of this grammar. Claude Code trims a paste,
    // which takes the escaped space off the end of a name and leaves its
    // backslash. No image is lost to it: such a name does not end like one.
    it("loses the space at the end of a name, which the shells keep", () => {
      const path = "/Users/me/Vault/name ",
        text = pasted(path, "posix");

      expect(text).toBe("/Users/me/Vault/name\\  ");
      expect(READERS.posix(text)).toEqual([path]);
      expect(claudeCodeReads(text, "posix")).toEqual([
        "/Users/me/Vault/name\\",
      ]);
    });

    it.each(
      windowsImages("posix-quoted").filter((path) => !shSingleQuoted(path)),
    )(
      "is the one image path %j once quoted for a shell of the sh family on Windows",
      (path) => {
        expect(claudeCodeReads(pasted(path, "posix-quoted"), "win32")).toEqual([
          path,
        ]);
      },
    );

    it.each(
      windowsImages("powershell").filter((path) => !powershellDoubled(path)),
    )("is the one image path %j once written for PowerShell", (path) => {
      expect(claudeCodeReads(pasted(path, "powershell"), "win32")).toEqual([
        path,
      ]);
    });

    it.each(
      // `cmd.exe` is not given a name with `%NAME%`.
      windowsImages("cmd").filter((path) => !/%[^%]+%/u.test(path)),
    )("is the one image path %j once written for cmd.exe", (path) => {
      expect(claudeCodeReads(pasted(path, "cmd"), "win32")).toEqual([path]);
    });

    it.each(
      // PowerShell on macOS or Linux. It has no backslash escape, so the
      // paths with a backslash or a place to cut at are the limit below.
      fixtureNames("powershell")
        .map((name) => TRICKY_POSIX + asImage(name))
        .filter(
          (path) =>
            !path.includes("\\") &&
            !CLAUDE_CODE_CUT.test(path) &&
            !powershellDoubled(path),
        ),
    )(
      "is the one image path %j once written for PowerShell under a POSIX directory",
      (path) => {
        expect(claudeCodeReads(pasted(path, "powershell"), "posix")).toEqual([
          path,
        ]);
      },
    );

    // Known limits. Where the shell and Claude Code cannot both be served,
    // the shell wins: Claude Code then shows the text instead of attaching
    // the file.
    it("is not the path once PowerShell needs its single quotes doubled", () => {
      const path = "C:\\Users\\me\\it's $5.png",
        text = pasted(path, "powershell");

      expect(text).toBe("'C:\\Users\\me\\it''s $5.png' ");
      expect(READERS.powershell(text)).toEqual([path]);
      expect(claudeCodeReads(text, "win32")).toEqual([
        "C:\\Users\\me\\it''s $5.png",
      ]);
    });

    it.each<readonly [string, string, string, readonly string[]]>([
      [
        // Quotes come off before the escapes do, so they do not keep it.
        "a backslash, which Claude Code takes for an escape",
        "/Users/me/back\\slash.png",
        "'/Users/me/back\\slash.png' ",
        ["/Users/me/backslash.png"],
      ],
      [
        "a space before a slash, where Claude Code cuts",
        "/Users/me/My Vault /photo.png",
        "'/Users/me/My Vault /photo.png' ",
        ["'/Users/me/My Vault", "/photo.png'"],
      ],
    ])(
      "is not the path once PowerShell quotes a POSIX path with %s",
      (_name, path, text, read) => {
        expect(pasted(path, "powershell")).toBe(text);
        expect(READERS.powershell(text)).toEqual([path]);
        expect(claudeCodeReads(text, "posix")).toEqual(read);
      },
    );
  });
});

describe("formatDroppedPaths", () => {
  it("gives one text per path and keeps their order", () => {
    expect(formatDroppedPaths(["/b.png", "/a.png", "/c.png"], "posix")).toEqual(
      { skipped: 0, texts: ["/b.png ", "/a.png ", "/c.png "] },
    );
  });

  it.each(GRAMMARS)(
    "ends every text for %s with one space after the path as formatDroppedPath writes it",
    (grammar) => {
      const paths = writtenPaths(grammar);

      expect(formatDroppedPaths(paths, grammar)).toEqual({
        skipped: 0,
        texts: paths.map((path) => `${written(path, grammar)} `),
      });
    },
  );

  it("removes duplicates, keeping the first, and does not count them as skipped", () => {
    expect(
      formatDroppedPaths(["/a.png", "/b.png", "/a.png", "/b.png"], "posix"),
    ).toEqual({ skipped: 0, texts: ["/a.png ", "/b.png "] });
  });

  it.each(GRAMMARS)("returns no text for no paths for %s", (grammar) => {
    expect(formatDroppedPaths([], grammar)).toEqual({ skipped: 0, texts: [] });
  });

  it("skips an empty path", () => {
    expect(formatDroppedPaths(["", "/a.png"], "posix")).toEqual({
      skipped: 1,
      texts: ["/a.png "],
    });
  });

  it.each(CONTROL_PATHS)(
    "skips a path with %s and keeps the others",
    (_name, path) => {
      expect(formatDroppedPaths([path], "posix")).toEqual({
        skipped: 1,
        texts: [],
      });
      expect(formatDroppedPaths([path], "cmd")).toEqual({
        skipped: 1,
        texts: [],
      });
      expect(
        formatDroppedPaths(["/ok/1.png", path, "/ok/2.png"], "posix"),
      ).toEqual({ skipped: 1, texts: ["/ok/1.png ", "/ok/2.png "] });
    },
  );

  it("skips a path the grammar has no way to write", () => {
    expect(formatDroppedPaths(['C:\\a"b.png', "C:\\c d.png"], "cmd")).toEqual({
      skipped: 1,
      texts: ['"C:\\c d.png" '],
    });
  });

  it("counts a skipped path once, however often it is dropped", () => {
    expect(
      formatDroppedPaths(["/a\nb.png", "", "/a\nb.png", "", "/c.png"], "posix"),
    ).toEqual({ skipped: 2, texts: ["/c.png "] });
  });

  it.each<readonly [ShellGrammar, readonly string[], readonly string[]]>([
    [
      "posix",
      ["/Users/me/My Vault/a b.png", "/Users/me/c.png"],
      ["/Users/me/My\\ Vault/a\\ b.png ", "/Users/me/c.png "],
    ],
    [
      "posix-quoted",
      ["C:\\Users\\me\\My Vault\\a.png", "C:\\Users\\me\\b.png"],
      ["'C:\\Users\\me\\My Vault\\a.png' ", "'C:\\Users\\me\\b.png' "],
    ],
    [
      "wsl",
      ["C:\\Users\\me\\My Vault\\a.png", "C:\\Users\\me\\b.png"],
      ["/mnt/c/Users/me/My\\ Vault/a.png ", "/mnt/c/Users/me/b.png "],
    ],
    [
      "powershell",
      ["C:\\Users\\me\\My Vault\\a.png", "C:\\Users\\me\\b.png"],
      ["'C:\\Users\\me\\My Vault\\a.png' ", "C:\\Users\\me\\b.png "],
    ],
    [
      "cmd",
      ["C:\\Users\\me\\My Vault\\a.png", "C:\\Users\\me\\b.png"],
      ['"C:\\Users\\me\\My Vault\\a.png" ', "C:\\Users\\me\\b.png "],
    ],
  ])("writes each path for %s", (grammar, paths, texts) => {
    expect(formatDroppedPaths(paths, grammar)).toEqual({ skipped: 0, texts });
  });

  it.each(GRAMMARS)(
    "gives the %s shell the dropped paths back when the texts are pasted one after another",
    (grammar) => {
      const paths = writtenPaths(grammar);

      expect(
        READERS[grammar](formatDroppedPaths(paths, grammar).texts.join("")),
      ).toEqual(paths);
    },
  );

  describe("with more paths than a drop inserts", () => {
    const numbered = (count: number): readonly string[] =>
      Array.from(
        { length: count },
        (_, index) => `/vault/${String(index)}.png`,
      );

    it("writes exactly as many paths as the cap allows", () => {
      const paths = numbered(MAX_DROPPED_PATHS);

      expect(formatDroppedPaths(paths, "posix")).toEqual({
        skipped: 0,
        texts: paths.map((path) => `${path} `),
      });
    });

    it("skips every path after the cap", () => {
      const paths = numbered(MAX_DROPPED_PATHS + 3);

      expect(formatDroppedPaths(paths, "posix")).toEqual({
        skipped: 3,
        texts: paths.slice(0, MAX_DROPPED_PATHS).map((path) => `${path} `),
      });
    });

    it("does not count duplicates after the cap as skipped", () => {
      const paths = numbered(MAX_DROPPED_PATHS + 1);

      expect(
        formatDroppedPaths([...paths, ...paths, ...paths], "posix").skipped,
      ).toBe(1);
    });

    it("does not let a skipped path take a place under the cap", () => {
      const paths = numbered(MAX_DROPPED_PATHS);

      expect(formatDroppedPaths(["/a\tb.png", "", ...paths], "posix")).toEqual({
        skipped: 2,
        texts: paths.map((path) => `${path} `),
      });
    });

    it("counts a path after the cap once, whether or not it could be written", () => {
      expect(
        formatDroppedPaths(
          [...numbered(MAX_DROPPED_PATHS), "/a\tb.png", "/late.png", ""],
          "posix",
        ).skipped,
      ).toBe(3);
    });
  });

  describe("with more bytes than the texts may have", () => {
    it("writes the paths whose texts fit exactly", () => {
      // Each text is 13 bytes with its space.
      expect(
        formatDroppedPaths(["/vault/a.png", "/vault/b.png"], "posix", {
          maxBytes: 26,
        }),
      ).toEqual({ skipped: 0, texts: ["/vault/a.png ", "/vault/b.png "] });
    });

    it("stops at the first path that does not fit, and skips it and those after it", () => {
      // The third does not fit 30 bytes; the fourth would, and is not written
      // either: what is pasted are the first paths of the drop.
      const paths = ["/vault/a.png", "/vault/b.png", "/vault/c.png", "/d"];

      expect(formatDroppedPaths(paths, "posix", { maxBytes: 30 })).toEqual({
        skipped: 2,
        texts: ["/vault/a.png ", "/vault/b.png "],
      });
    });

    it("counts the bytes of a text as UTF-8, with its escapes", () => {
      // `/é\ 😀 ` is 1 + 2 + 2 + 4 + 1 bytes.
      expect(
        formatDroppedPaths(["/é 😀"], "posix", { maxBytes: 10 }).texts,
      ).toEqual(["/é\\ 😀 "]);
      expect(formatDroppedPaths(["/é 😀"], "posix", { maxBytes: 9 })).toEqual({
        skipped: 1,
        texts: [],
      });
    });

    it("does not count a duplicate or a path that cannot be written", () => {
      expect(
        formatDroppedPaths(
          ["/vault/a.png", "/vault/a.png", "/a\tb.png", "/vault/b.png"],
          "posix",
          { maxBytes: 26 },
        ),
      ).toEqual({ skipped: 1, texts: ["/vault/a.png ", "/vault/b.png "] });
    });

    it.each([null, undefined])("has no limit with %s", (maxBytes) => {
      const paths = Array.from(
        { length: MAX_DROPPED_PATHS },
        (_, index) => `/vault/${String(index)}.png`,
      );

      expect(formatDroppedPaths(paths, "posix", { maxBytes }).skipped).toBe(0);
    });
  });
});

describe("lineByteLimit", () => {
  // What the terminal driver keeps of a line, less 256 bytes for what is
  // typed before the drop: 4096 bytes on Linux, 1024 on macOS.
  it.each<readonly [string, Platform.All, number]>([
    ["/bin/dash", "linux", 3840],
    ["dash", "linux", 3840],
    // `sh` is dash on Debian and Ubuntu.
    ["/bin/sh", "linux", 3840],
    ["sh", "linux", 3840],
    ["/bin/dash", "darwin", 768],
    ["/opt/homebrew/bin/dash", "darwin", 768],
  ])(
    "bounds a paste into %s on %s, which has no line editor, to %i bytes",
    (executable, platform, limit) => {
      expect(lineByteLimit(executable, platform)).toBe(limit);
    },
  );

  it.each<readonly [string, Platform.All]>([
    // bash on macOS, which edits its line itself.
    ["/bin/sh", "darwin"],
    ["/bin/bash", "linux"],
    ["/bin/bash", "darwin"],
    ["/bin/zsh", "darwin"],
    ["/usr/bin/zsh", "linux"],
    ["/usr/bin/fish", "linux"],
    ["/bin/ksh", "darwin"],
    ["pwsh", "linux"],
    // A program that is not known is not bounded.
    ["", "linux"],
    ["", "darwin"],
    ["/usr/bin/cat", "linux"],
    ["/usr/local/bin/dash-wrapper", "linux"],
    // Windows has no terminal driver that cuts a line.
    ["dash.exe", "win32"],
    ["sh", "win32"],
    ["/bin/sh", "android"],
    ["/bin/dash", "unknown"],
  ])("sets no limit for %j on %s", (executable, platform) => {
    expect(lineByteLimit(executable, platform)).toBeNull();
  });

  it.each(INTEGRATED_PRESETS)(
    "bounds only the dash and Linux sh presets: %s on %s",
    (key, platform, executable) => {
      expect(lineByteLimit(executable, platform) !== null).toBe(
        key === "dashIntegrated" ||
          (platform === "linux" &&
            (key === "shIntegrated" || key === "linuxIntegratedDefault")),
      );
    },
  );
});

/** The platforms where dropped paths are one paste: all but Windows. */
const ONE_PASTE_PLATFORMS: readonly Platform.All[] = [
    "darwin",
    "linux",
    "android",
    "ios",
    "unknown",
  ],
  ALL_PLATFORMS: readonly Platform.All[] = [...ONE_PASTE_PLATFORMS, "win32"];

/**
 * The one paste that inserts dropped paths on macOS, with every path in it.
 */
function onePaste(paths: readonly string[], grammar: ShellGrammar): string {
  const { skipped, texts } = formatDroppedPaths(paths, grammar),
    pastes = droppedPathPastes(texts, "darwin"),
    [paste] = pastes;
  if (skipped !== 0 || pastes.length !== 1 || typeof paste === "undefined") {
    throw new Error(
      `${grammar} gives no one paste of ${JSON.stringify(paths)}`,
    );
  }
  return paste;
}

describe("droppedPathPastes", () => {
  it.each(ONE_PASTE_PLATFORMS)(
    "puts several texts into one paste on %s, in order",
    (platform) => {
      expect(
        droppedPathPastes(["/a\\ b.png ", "/c.png ", "/d.png "], platform),
      ).toEqual(["/a\\ b.png /c.png /d.png "]);
    },
  );

  it("keeps each of several texts a paste of its own on win32, in order", () => {
    const texts = ["'C:\\a b.png' ", "C:\\c.png ", '"C:\\d\'e.png" '];

    expect(droppedPathPastes(texts, "win32")).toEqual(texts);
  });

  it.each(ALL_PLATFORMS)("leaves a single text as it is on %s", (platform) => {
    expect(droppedPathPastes(["/a\\ b.png "], platform)).toEqual([
      "/a\\ b.png ",
    ]);
  });

  it.each(ALL_PLATFORMS)("makes no paste of no texts on %s", (platform) => {
    expect(droppedPathPastes([], platform)).toEqual([]);
  });

  it("puts as many texts as a drop inserts into one paste", () => {
    const { texts } = formatDroppedPaths(
      Array.from(
        { length: MAX_DROPPED_PATHS },
        (_, index) => `/vault/${String(index)}.png`,
      ),
      "posix",
    );

    expect(droppedPathPastes(texts, "darwin")).toEqual([texts.join("")]);
  });

  describe("as one paste of escaped paths", () => {
    it("gives a POSIX shell every path back, in order", () => {
      const paths = writtenPaths("posix");

      expect(READERS.posix(onePaste(paths, "posix"))).toEqual(paths);
    });

    it("gives Claude Code every image path back, in order", () => {
      expect(claudeCodeReads(onePaste(POSIX_IMAGES, "posix"), "posix")).toEqual(
        POSIX_IMAGES,
      );
    });

    it("gives Claude Code both image paths of every pair back, in order", () => {
      const misread = POSIX_IMAGES.flatMap((first) =>
        POSIX_IMAGES.filter((second) => second !== first).map(
          (second): readonly string[] => [first, second],
        ),
      ).filter((pair) => {
        const [first, second] = pair,
          read = claudeCodeReads(onePaste(pair, "posix"), "posix");
        return !(read.length === 2 && read[0] === first && read[1] === second);
      });

      expect(misread).toEqual([]);
    });

    // The names with a place where Claude Code would cut, or with what its
    // cut is made of: none may take a part of the path next to it, or lose one.
    it.each<readonly [string, string]>([
      ["a slash after a space", "space /before slash.png"],
      ["a slash after a space and a quote", "it's /both.png"],
      ["a colon after a space and a letter", "Plan B: draft.png"],
      ["colons", "12:30:15.png"],
      ["a drive after a space", "a C:\\shot.png"],
      ["a backslash", "back\\slash.png"],
      ["a backslash at its end", "end\\.png\\"],
    ])(
      "keeps the name with %s whole between two other paths for Claude Code",
      (_name, name) => {
        const directory = "/Users/me/My Vault /Plan B: drafts/",
          paths = [
            `${directory}first one.png`,
            directory + name,
            `${directory}last one.png`,
          ];

        expect(claudeCodeReads(onePaste(paths, "posix"), "posix")).toEqual(
          paths,
        );
        expect(READERS.posix(onePaste(paths, "posix"))).toEqual(paths);
      },
    );
  });

  // Known limit. PowerShell on macOS or Linux gets one paste as every shell
  // there does, and a quote leaves Claude Code no place to cut at: it then
  // shows the text instead of attaching the files.
  describe("as one paste of paths written for PowerShell under a POSIX directory", () => {
    it("gives Claude Code the paths that need no quotes", () => {
      const paths = ["/Users/me/a.png", "/Users/me/b.png"],
        paste = onePaste(paths, "powershell");

      expect(paste).toBe("/Users/me/a.png /Users/me/b.png ");
      expect(READERS.powershell(paste)).toEqual(paths);
      expect(claudeCodeReads(paste, "posix")).toEqual(paths);
    });

    it("is not the paths for Claude Code once they are quoted", () => {
      const paths = ["/Users/me/a b.png", "/Users/me/c d.png"],
        paste = onePaste(paths, "powershell");

      expect(paste).toBe("'/Users/me/a b.png' '/Users/me/c d.png' ");
      expect(READERS.powershell(paste)).toEqual(paths);
      expect(claudeCodeReads(paste, "posix")).toEqual([
        "/Users/me/a b.png' '/Users/me/c d.png",
      ]);
    });
  });
});

const RESOURCE_PREFIX = "app://3f9a1c0be27d/",
  // A `text/uri-list`, where a `#` is no fragment.
  POSIX: UriListOptions = {
    fragments: false,
    platform: "darwin",
    resourcePrefix: RESOURCE_PREFIX,
  },
  WIN32: UriListOptions = {
    fragments: false,
    platform: "win32",
    resourcePrefix: RESOURCE_PREFIX,
  },
  // A list of Visual Studio Code, where it is one.
  POSIX_FRAGMENTS: UriListOptions = { ...POSIX, fragments: true },
  WIN32_FRAGMENTS: UriListOptions = { ...WIN32, fragments: true },
  // 1 MiB, in UTF-16 code units.
  URI_LIST_LIMIT = 1_048_576;

/**
 * The vault of the drags measured out of Visual Studio Code 1.141.0 on
 * Windows 11, as its URIs have it (lower-case drive, encoded colon) and as a
 * path. The URIs of the tests that name it are the measured strings.
 */
const VSCODE_VAULT_URI = "file:///c%3A/Users/janah/Downloads/tes-206-dnd",
  VSCODE_VAULT = "C:\\Users\\janah\\Downloads\\tes-206-dnd";

describe("uriListPaths", () => {
  it("skips a raw backslash off Windows, which the URL parser reads as a slash", () => {
    const options: UriListOptions = {
      fragments: false,
      platform: "darwin",
      resourcePrefix: "",
    };
    expect(
      uriListPaths("file:///Users/me/back\\slash.md", options),
    ).toStrictEqual({ paths: [], skipped: 1 });
    // Encoded, it is the character of the name.
    expect(
      uriListPaths("file:///Users/me/back%5Cslash.md", options),
    ).toStrictEqual({ paths: ["/Users/me/back\\slash.md"], skipped: 0 });
    // On Windows a backslash is a separator either way.
    expect(
      uriListPaths("file:///C:\\Users\\me\\a.png", {
        ...options,
        platform: "win32",
      }),
    ).toStrictEqual({ paths: ["C:\\Users\\me\\a.png"], skipped: 0 });
  });

  it.each<readonly [string, string, string]>([
    ["a plain name", "file:///Users/me/Vault/a.png", "/Users/me/Vault/a.png"],
    [
      "encoded spaces",
      "file:///Users/me/My%20Vault/photo%20space.jpg",
      "/Users/me/My Vault/photo space.jpg",
    ],
    [
      "encoded unicode",
      "file:///Users/me/%C3%BCn%C3%AFc%C3%B8d%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%F0%9F%98%80.png",
      "/Users/me/ünïcødé 日本語 😀.png",
    ],
    ["raw unicode", "file:///Users/me/日本語.png", "/Users/me/日本語.png"],
    [
      "an encoded hash",
      "file:///Users/me/semi;colon%20%23hash%20!bang.md",
      "/Users/me/semi;colon #hash !bang.md",
    ],
    [
      "an encoded question mark and other encoded punctuation",
      "file:///Users/me/star*%20question%3F%20pipe%7C%20lt%3C%20gt%3E.md",
      "/Users/me/star* question? pipe| lt< gt>.md",
    ],
    [
      "an encoded percent sign",
      "file:///Users/me/100%25%20%5Bbrackets%5D%20%7Bbraces%7D%20%5Ecaret.png",
      "/Users/me/100% [brackets] {braces} ^caret.png",
    ],
    [
      "an encoded backslash, which is part of a name there",
      "file:///Users/me/back%5Cslash.md",
      "/Users/me/back\\slash.md",
    ],
    [
      "the host localhost",
      "file://localhost/Users/me/a.png",
      "/Users/me/a.png",
    ],
    ["a folder", "file:///Users/me/Vault/Folder/", "/Users/me/Vault/Folder/"],
    ["one slash", "file:/Users/me/a.png", "/Users/me/a.png"],
    ["the scheme in upper case", "FILE:///Users/me/a.png", "/Users/me/a.png"],
    ["the scheme in mixed case", "File:/Users/me/a.png", "/Users/me/a.png"],
    ["a raw space", "file:///Users/me/a b.png", "/Users/me/a b.png"],
  ])("reads a POSIX file URI with %s", (_name, uri, path) => {
    expect(uriListPaths(uri, POSIX)).toEqual({ paths: [path], skipped: 0 });
    expect(uriListPaths(uri, POSIX_FRAGMENTS)).toEqual({
      paths: [path],
      skipped: 0,
    });
  });

  // Chromium, which Obsidian runs in, keeps the host `localhost` of a `file:`
  // URI: `new URL("file://LOCALHOST/a").hostname` is "localhost" in Chrome
  // 154. The parser of Node, which runs these tests, reads it as no host, so
  // the cases with that host above and below do not show that it is compared.
  it.each<readonly [string, UriListOptions, string, string]>([
    ["a POSIX", POSIX, "file://localhost/Users/me/a.png", "/Users/me/a.png"],
    [
      "a Windows",
      WIN32,
      "file://LOCALHOST/C:/Users/me/a.png",
      "C:\\Users\\me\\a.png",
    ],
  ])(
    "reads %s file URI with the host localhost as Chromium parses it",
    (_name, options, uri, path) => {
      class ChromiumUrl extends URL {
        readonly #localhost: boolean;

        public constructor(url: string) {
          super(url);
          this.#localhost = /^file:\/\/localhost\//iu.test(url);
        }

        public override get hostname(): string {
          return this.#localhost ? "localhost" : super.hostname;
        }
      }
      vi.stubGlobal("URL", ChromiumUrl);
      try {
        expect(uriListPaths(uri, options)).toEqual({
          paths: [path],
          skipped: 0,
        });
        // Any other host is still a network share.
        expect(uriListPaths("file://server/share/a.png", options)).toEqual({
          paths: [],
          skipped: 1,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each<Platform.All>(["linux", "android", "ios", "unknown"])(
    "reads a POSIX file URI on %s",
    (platform) => {
      expect(
        uriListPaths("file:///home/me/a%20b.png", {
          fragments: false,
          platform,
          resourcePrefix: RESOURCE_PREFIX,
        }),
      ).toEqual({ paths: ["/home/me/a b.png"], skipped: 0 });
    },
  );

  it.each<readonly [string, string, string]>([
    [
      "a plain name",
      "file:///C:/Users/me/Vault/a.png",
      "C:\\Users\\me\\Vault\\a.png",
    ],
    [
      "encoded spaces",
      "file:///C:/Users/me/My%20Vault/photo%20space.jpg",
      "C:\\Users\\me\\My Vault\\photo space.jpg",
    ],
    [
      "encoded unicode",
      "file:///C:/Users/me/%C3%BCn%C3%AFc%C3%B8d%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%F0%9F%98%80.png",
      "C:\\Users\\me\\ünïcødé 日本語 😀.png",
    ],
    [
      "an encoded hash",
      "file:///C:/Users/me/My%20Vault/a%23b.png",
      "C:\\Users\\me\\My Vault\\a#b.png",
    ],
    [
      "an encoded percent sign",
      "file:///C:/Users/me/100%25.png",
      "C:\\Users\\me\\100%.png",
    ],
    [
      "a lower-case drive, written in upper case",
      "file:///d:/Vault/a.png",
      "D:\\Vault\\a.png",
    ],
    [
      "a lower-case drive with an encoded colon",
      "file:///c%3A/Users/me/a.png",
      "C:\\Users\\me\\a.png",
    ],
    [
      "an upper-case drive with an encoded colon",
      "file:///C%3a/Users/me/a.png",
      "C:\\Users\\me\\a.png",
    ],
    [
      "the host localhost",
      "file://localhost/C:/Users/me/a.png",
      "C:\\Users\\me\\a.png",
    ],
    ["a drive root", "file:///C:/", "C:\\"],
    ["a lower-case drive root", "file:///c%3A/", "C:\\"],
    ["one slash", "file:/C:/Users/me/a.png", "C:\\Users\\me\\a.png"],
    [
      "the scheme in upper case",
      "FILE:///C:/Users/me/a.png",
      "C:\\Users\\me\\a.png",
    ],
  ])("reads a Windows file URI with %s", (_name, uri, path) => {
    expect(uriListPaths(uri, WIN32)).toEqual({ paths: [path], skipped: 0 });
    expect(uriListPaths(uri, WIN32_FRAGMENTS)).toEqual({
      paths: [path],
      skipped: 0,
    });
  });

  it.each<readonly [string, string]>([
    ["a network host", "file://server/share/a.png"],
    ["a network host given by address", "file://192.168.1.2/share/a.png"],
    ["a network share in the path", "file://///server/share/a.png"],
    [
      "a network share in the path after localhost",
      "file://localhost//server/share/a.png",
    ],
    ["an encoded slash", "file:///Users/me/a%2Fb.png"],
    ["an encoded slash in lower case", "file:///Users/me/a%2fb.png"],
    ["a raw hash", "file:///Users/me/semi;colon #hash.md"],
    ["a raw question mark", "file:///Users/me/what?.md"],
    ["nothing but a question mark after the name", "file:///Users/me/a.png?"],
    ["nothing but a hash after the name", "file:///Users/me/a.png#"],
    ["a query", "file:///Users/me/a.png?1717171717171"],
    ["a fragment", "file:///Users/me/a.md#Heading"],
    ["a percent sign that encodes nothing", "file:///Users/me/100%.png"],
    ["a percent escape that is not hexadecimal", "file:///Users/me/%zz.png"],
    ["a percent escape cut short", "file:///Users/me/a%2"],
    ["a percent escape that is not UTF-8", "file:///Users/me/%E9.png"],
    // The URL parser would make `/relative.png` and `/` of these.
    ["a relative path", "file:relative.png"],
    ["a relative path in a folder", "file:Notes/a.md"],
    ["a relative path with a drive", "file:C:/Users/me/a.png"],
    ["no path", "file:"],
    ["no path, in upper case", "FILE:"],
    ["backslashes for the slashes", "file:\\\\\\Users\\me\\a.png"],
    ["a space after the scheme", "file: ///Users/me/a.png"],
    // Not URLs at all.
    ["a host that is cut short", "file://[::1/Users/me/a.png"],
    ["a host with a space", "file://my host/share/a.png"],
  ])("skips a file URI with %s on every platform", (_name, uri) => {
    expect(uriListPaths(uri, POSIX)).toEqual({ paths: [], skipped: 1 });
    expect(uriListPaths(uri, WIN32)).toEqual({ paths: [], skipped: 1 });
  });

  it.each<readonly [string, string]>([
    ["a tab", "\t"],
    ["a vertical tab", "\u000b"],
    ["a form feed", "\u000c"],
    ["a NUL", "\u0000"],
    ["an escape", "\u001b"],
    ["a unit separator", "\u001f"],
    ["a DEL", "\u007f"],
    ["the first C1 control character", "\u0080"],
    ["a next line", "\u0085"],
    ["a control sequence introducer", "\u009b"],
    ["the last C1 control character", "\u009f"],
  ])(
    "skips a file URI with %s in it, which the URL parser may drop",
    (_name, control) => {
      for (const uri of [
        `file:///C:/Users/me/a${control}b.png`,
        `file:///C:/Users/me/a.png#x${control}y`,
        `file:///C:/${control}Users/me/a.png`,
        `fi${control}le:///C:/Users/me/a.png`,
      ]) {
        for (const options of [
          POSIX,
          WIN32,
          POSIX_FRAGMENTS,
          WIN32_FRAGMENTS,
        ]) {
          expect(uriListPaths(uri, options)).toEqual({ paths: [], skipped: 1 });
        }
      }
    },
  );

  it.each<readonly [string, string]>([
    ["a NUL", "\u0000"],
    ["an escape", "\u001b"],
    ["a unit separator", "\u001f"],
    ["a DEL", "\u007f"],
    ["a next line", "\u0085"],
  ])("skips a file URI with %s at an end", (_name, control) => {
    for (const uri of [
      `file:///Users/me/a.png${control}`,
      `${control}file:///Users/me/a.png`,
    ]) {
      expect(uriListPaths(uri, POSIX)).toEqual({ paths: [], skipped: 1 });
      expect(uriListPaths(uri, POSIX_FRAGMENTS)).toEqual({
        paths: [],
        skipped: 1,
      });
    }
  });

  it.each<readonly [string, string]>([
    ["an encoded backslash", "file:///C:/Users/me/back%5Cslash.md"],
    [
      "an encoded backslash in lower case",
      "file:///C:/Users/me/back%5cslash.md",
    ],
    ["an encoded slash", "file:///C:/Users/me/a%2Fb.png"],
    ["no drive", "file:///Users/me/a.png"],
    ["a drive without a path", "file:///C:"],
    ["a drive of two letters", "file:///CD:/a.png"],
    ["a share where the drive belongs", "file:////server/share/a.png"],
  ])("skips a file URI with %s on Windows", (_name, uri) => {
    expect(uriListPaths(uri, WIN32)).toEqual({ paths: [], skipped: 1 });
  });

  it.each<readonly [string, string]>([
    ["http", "http://example.com/a.png"],
    ["https", "https://example.com/Users/me/a.png"],
    ["an Obsidian link", "obsidian://open?vault=Vault&file=Notes%2Fa.md"],
    ["an Obsidian link without a query", "obsidian://open/Users/me/a.md"],
    ["a remote editor file", "vscode-remote://ssh-remote+host/home/me/a.png"],
    ["an unsaved editor file", "untitled:Untitled-1"],
    // Nothing but the scheme tells these from a `file:` URI of this machine.
    ["an unsaved editor file with a path", "untitled:/Users/me/new.md"],
    [
      "an unsaved editor file with a drive path",
      "untitled:/C:/Users/me/new.md",
    ],
    ["another scheme without a host", "sftp:///Users/me/a.png"],
    [
      "another scheme without a host, with a drive",
      "sftp:///C:/Users/me/a.png",
    ],
    ["a resource URL of another Obsidian", "app://0000aaaa1111/Users/me/a.png"],
    ["data", "data:text/plain;base64,L1VzZXJzL21lL2EucG5n"],
    ["a POSIX path", "/Users/me/a.png"],
    ["a Windows path", "C:\\Users\\me\\a.png"],
    ["a relative path", "Notes/a.md"],
    ["a file name", "a.png"],
    ["text", "not a URI"],
  ])("skips %s", (_name, entry) => {
    for (const options of [POSIX, WIN32, POSIX_FRAGMENTS, WIN32_FRAGMENTS]) {
      expect(uriListPaths(entry, options)).toEqual({ paths: [], skipped: 1 });
    }
  });

  it("returns nothing for an empty payload", () => {
    expect(uriListPaths("", POSIX)).toEqual({ paths: [], skipped: 0 });
  });

  it("ignores comments and blank lines, also indented ones", () => {
    expect(
      uriListPaths(
        [
          "# Dragged from a note",
          "",
          "file:///Users/me/a.png",
          "   ",
          "  # file:///Users/me/commented.png",
          "#",
          "file:///Users/me/b.png",
          "",
        ].join("\r\n"),
        POSIX,
      ),
    ).toEqual({ paths: ["/Users/me/a.png", "/Users/me/b.png"], skipped: 0 });
  });

  it.each<readonly [string, string]>([
    ["CRLF", "\r\n"],
    ["LF", "\n"],
    ["CR", "\r"],
  ])("reads one URI per line with %s line ends", (_name, lineEnd) => {
    expect(
      uriListPaths(
        ["file:///Users/me/a.png", "file:///Users/me/b.png", ""].join(lineEnd),
        POSIX,
      ),
    ).toEqual({ paths: ["/Users/me/a.png", "/Users/me/b.png"], skipped: 0 });
  });

  // A source that encodes names leaves no white space around a URI, and the
  // URI without it names another path: `a.png`, not `a.png` and a tab.
  it.each<readonly [string, string]>([
    ["a tab after it", "file:///Users/me/a.png\t"],
    ["a space after it", "file:///Users/me/a.png "],
    ["a no-break space after it", "file:///Users/me/a.png\u00a0"],
    ["a vertical tab after it", "file:///Users/me/a.png\u000b"],
    ["a form feed after it", "file:///Users/me/a.png\u000c"],
    ["a line separator after it", "file:///Users/me/a.png\u2028"],
    ["a space after its fragment", "file:///Users/me/a.md#Heading "],
    ["a space before it", " file:///Users/me/a.png"],
    ["a tab before it", "\tfile:///Users/me/a.png"],
    ["a no-break space before it", "\u00a0file:///Users/me/a.png"],
    ["spaces around it", "  file:///Users/me/a.png\t"],
  ])("skips a file URI with %s instead of trimming it", (_name, line) => {
    for (const options of [POSIX, POSIX_FRAGMENTS]) {
      expect(uriListPaths(line, options)).toEqual({ paths: [], skipped: 1 });
    }
  });

  it("skips a Windows file URI with a tab after it", () => {
    expect(uriListPaths("file:///C:/tmp/a.png\t", WIN32)).toEqual({
      paths: [],
      skipped: 1,
    });
  });

  it("skips only the lines with white space at an end in a list with CRLF line ends", () => {
    expect(
      uriListPaths(
        [
          "file:///Users/me/a.png",
          "file:///Users/me/b.png\t",
          " file:///Users/me/c.png",
          "file:///Users/me/d.png",
          "",
        ].join("\r\n"),
        POSIX,
      ),
    ).toEqual({ paths: ["/Users/me/a.png", "/Users/me/d.png"], skipped: 2 });
  });

  it("keeps the order and the duplicates, and counts each entry without a path", () => {
    expect(
      uriListPaths(
        [
          "file:///Users/me/b.png",
          "https://example.com/a.png",
          "file:///Users/me/a%20c.png",
          "file://server/share/a.png",
          "file:///Users/me/b.png",
          "https://example.com/a.png",
        ].join("\n"),
        POSIX,
      ),
    ).toEqual({
      paths: ["/Users/me/b.png", "/Users/me/a c.png", "/Users/me/b.png"],
      skipped: 3,
    });
  });

  it("leaves a decoded control character to formatDroppedPaths, which skips the path", () => {
    const { paths } = uriListPaths("file:///Users/me/new%0Aline.md", POSIX);

    expect(paths).toEqual(["/Users/me/new\nline.md"]);
    expect(formatDroppedPaths(paths, "posix")).toEqual({
      skipped: 1,
      texts: [],
    });
  });

  describe("with fragments", () => {
    it.each<readonly [string, string, string]>([
      ["a fragment", "file:///Users/me/a.md#Heading", "/Users/me/a.md"],
      [
        "nothing but a hash after the name",
        "file:///Users/me/a.png#",
        "/Users/me/a.png",
      ],
      [
        "a fragment with a hash and a question mark in it",
        "file:///Users/me/a.md#L1?x#y",
        "/Users/me/a.md",
      ],
      [
        "an encoded hash in the name and a fragment",
        "file:///Users/me/a%23b.md#c",
        "/Users/me/a#b.md",
      ],
      [
        "a fragment with a space in it",
        "file:///Users/me/a.md#My Heading",
        "/Users/me/a.md",
      ],
    ])("reads the path of a file URI with %s", (_name, uri, path) => {
      expect(uriListPaths(uri, POSIX_FRAGMENTS)).toEqual({
        paths: [path],
        skipped: 0,
      });
      expect(uriListPaths(uri, POSIX)).toEqual({ paths: [], skipped: 1 });
    });

    it.each<readonly [string, string]>([
      ["a query", "file:///Users/me/a.png?1717171717171"],
      ["a query before the fragment", "file:///Users/me/a.png?v=1#x"],
      ["a raw question mark", "file:///Users/me/what?.md"],
      ["nothing but a question mark after the name", "file:///Users/me/a.png?"],
      // The URL parser would take the space off, and name `semi;colon`.
      ["a space before the fragment", "file:///Users/me/semi;colon #hash.md"],
      ["a relative path and a fragment", "file:a.md#Heading"],
      ["nothing but a fragment after the scheme", "file:#Heading"],
      ["another scheme and a fragment", "https://example.com/a.png#x"],
    ])("still skips a file URI with %s", (_name, uri) => {
      expect(uriListPaths(uri, POSIX_FRAGMENTS)).toEqual({
        paths: [],
        skipped: 1,
      });
      expect(uriListPaths(uri, WIN32_FRAGMENTS)).toEqual({
        paths: [],
        skipped: 1,
      });
    });

    it("still takes a line that starts with a hash for a comment", () => {
      expect(
        uriListPaths(
          "#file:///Users/me/a.png\r\n  # b\r\nfile:///Users/me/c.png#d",
          POSIX_FRAGMENTS,
        ),
      ).toEqual({ paths: ["/Users/me/c.png"], skipped: 0 });
    });

    it("reads the path of a resource URL with a fragment", () => {
      const uri = `${RESOURCE_PREFIX}Users/me/a.png?1717171717171#x`;

      expect(uriListPaths(uri, POSIX_FRAGMENTS)).toEqual({
        paths: ["/Users/me/a.png"],
        skipped: 0,
      });
      expect(uriListPaths(uri, POSIX)).toEqual({ paths: [], skipped: 1 });
    });
  });

  describe("with a list of Visual Studio Code, as measured", () => {
    it.each<readonly [string, string, string]>([
      ["a file", "/Images/photo.png", "\\Images\\photo.png"],
      [
        "a file with a space",
        "/Images/photo%20space.jpg",
        "\\Images\\photo space.jpg",
      ],
      ["a folder", "/Images", "\\Images"],
      ["an editor tab", "/Notes/Plain.md", "\\Notes\\Plain.md"],
      [
        "a search result",
        "/.obsidian/workspace.json",
        "\\.obsidian\\workspace.json",
      ],
      [
        "a file with letters of other scripts and an emoji",
        "/Tricky/%C3%BCn%C3%AFc%C3%B8d%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%F0%9F%98%80.png",
        "\\Tricky\\ünïcødé 日本語 😀.png",
      ],
    ])("reads the path of %s", (_name, uri, path) => {
      expect(uriListPaths(VSCODE_VAULT_URI + uri, WIN32_FRAGMENTS)).toEqual({
        paths: [VSCODE_VAULT + path],
        skipped: 0,
      });
      // The first entry is in `text/uri-list` as well.
      expect(uriListPaths(VSCODE_VAULT_URI + uri, WIN32)).toEqual({
        paths: [VSCODE_VAULT + path],
        skipped: 0,
      });
    });

    it("reads every file of a selection, which CRLF separates and no line break ends", () => {
      expect(
        uriListPaths(
          `${VSCODE_VAULT_URI}/Images/photo.png\r\n${VSCODE_VAULT_URI}/Images/second.png`,
          WIN32_FRAGMENTS,
        ),
      ).toEqual({
        paths: [
          `${VSCODE_VAULT}\\Images\\photo.png`,
          `${VSCODE_VAULT}\\Images\\second.png`,
        ],
        skipped: 0,
      });
    });

    it("reads a folder and a file of one selection", () => {
      expect(
        uriListPaths(
          `${VSCODE_VAULT_URI}/Notes\r\n${VSCODE_VAULT_URI}/manifest.fixtures.json`,
          WIN32_FRAGMENTS,
        ),
      ).toEqual({
        paths: [
          `${VSCODE_VAULT}\\Notes`,
          `${VSCODE_VAULT}\\manifest.fixtures.json`,
        ],
        skipped: 0,
      });
    });

    it("reads the names in which nearly every punctuation mark is encoded", () => {
      expect(
        uriListPaths(
          [
            "/Tricky/100%25%20%5Bbrackets%5D%20%7Bbraces%7D%20%5Ecaret.png",
            "/Tricky/comma%2C%20equals%3Dplus%2B%20at%40%20tilde~.md",
            "/Tricky/dollar%20%24HOME%20%60tick%60.md",
            "/Tricky/it%27s%20a%20%28test%29%20%26%20more.md",
            "/Tricky/semi%3Bcolon%20%23hash%20%21bang.md",
            "/Tricky/two%20%20spaces.png",
            "/Tricky/%C3%BCn%C3%AFc%C3%B8d%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%F0%9F%98%80.png",
          ]
            .map((uri) => VSCODE_VAULT_URI + uri)
            .join("\r\n"),
          WIN32_FRAGMENTS,
        ),
      ).toEqual({
        paths: [
          "\\Tricky\\100% [brackets] {braces} ^caret.png",
          "\\Tricky\\comma, equals=plus+ at@ tilde~.md",
          "\\Tricky\\dollar $HOME `tick`.md",
          "\\Tricky\\it's a (test) & more.md",
          "\\Tricky\\semi;colon #hash !bang.md",
          "\\Tricky\\two  spaces.png",
          "\\Tricky\\ünïcødé 日本語 😀.png",
        ].map((path) => VSCODE_VAULT + path),
        skipped: 0,
      });
    });

    it("reads the file of a search match, whose place in the file is a fragment", () => {
      const uri = `${VSCODE_VAULT_URI}/.obsidian/workspace.json#251%2C29-251%2C34`;

      expect(uriListPaths(uri, WIN32_FRAGMENTS)).toEqual({
        paths: [`${VSCODE_VAULT}\\.obsidian\\workspace.json`],
        skipped: 0,
      });
      // Read as a `text/uri-list`, where a `#` is a name that was not encoded.
      expect(uriListPaths(uri, WIN32)).toEqual({ paths: [], skipped: 1 });
    });

    it("skips an editor that has no file", () => {
      expect(uriListPaths("untitled:Untitled-1", WIN32_FRAGMENTS)).toEqual({
        paths: [],
        skipped: 1,
      });
    });

    it("reads the files around an editor that has none", () => {
      expect(
        uriListPaths(
          `${VSCODE_VAULT_URI}/Notes/Plain.md\r\nuntitled:Untitled-1\r\n${VSCODE_VAULT_URI}/Images`,
          WIN32_FRAGMENTS,
        ),
      ).toEqual({
        paths: [`${VSCODE_VAULT}\\Notes\\Plain.md`, `${VSCODE_VAULT}\\Images`],
        skipped: 1,
      });
    });
  });

  describe("with an Obsidian resource URL", () => {
    it.each<readonly [string, string, string]>([
      [
        "a modification time",
        `${RESOURCE_PREFIX}Users/me/Vault/Pasted%20image.png?1717171717171`,
        "/Users/me/Vault/Pasted image.png",
      ],
      [
        "no modification time",
        `${RESOURCE_PREFIX}Users/me/Vault/Pasted%20image.png`,
        "/Users/me/Vault/Pasted image.png",
      ],
      [
        "an encoded hash and question mark in the name",
        `${RESOURCE_PREFIX}Users/me/a%23b%3Fc.png?1717171717171`,
        "/Users/me/a#b?c.png",
      ],
      [
        "a name that ends like a modification time",
        `${RESOURCE_PREFIX}Users/me/a%3F123?1717171717171`,
        "/Users/me/a?123",
      ],
    ])("reads a POSIX path with %s", (_name, uri, path) => {
      expect(uriListPaths(uri, POSIX)).toEqual({ paths: [path], skipped: 0 });
    });

    it.each<readonly [string, string, string]>([
      [
        "a modification time",
        `${RESOURCE_PREFIX}C:/Users/me/Vault/Pasted%20image.png?1717171717171`,
        "C:\\Users\\me\\Vault\\Pasted image.png",
      ],
      [
        "no modification time",
        `${RESOURCE_PREFIX}C:/Users/me/Vault/Pasted%20image.png`,
        "C:\\Users\\me\\Vault\\Pasted image.png",
      ],
      [
        "an encoded hash in the name",
        `${RESOURCE_PREFIX}C:/Users/me/a%23b.png?1717171717171`,
        "C:\\Users\\me\\a#b.png",
      ],
      [
        "a lower-case drive and an encoded colon",
        `${RESOURCE_PREFIX}c%3A/Users/me/Vault/Pasted%20image.png?1717171717171`,
        "C:\\Users\\me\\Vault\\Pasted image.png",
      ],
    ])("reads a Windows path with %s", (_name, uri, path) => {
      expect(uriListPaths(uri, WIN32)).toEqual({ paths: [path], skipped: 0 });
    });

    it.each<readonly [string, string]>([
      ["a second query", "Users/me/a.png?1?2"],
      ["a query that is not a modification time", "Users/me/a.png?v=1"],
      ["a fragment", "Users/me/a.png?1717171717171#x"],
      ["a raw hash", "Users/me/a#b.png?1717171717171"],
      ["an encoded slash", "Users/me/a%2Fb.png?1717171717171"],
      ["a malformed percent escape", "Users/me/100%.png?1717171717171"],
      ["a network share", "/server/share/a.png?1717171717171"],
    ])("skips one with %s", (_name, rest) => {
      expect(uriListPaths(RESOURCE_PREFIX + rest, POSIX)).toEqual({
        paths: [],
        skipped: 1,
      });
      expect(uriListPaths(RESOURCE_PREFIX + rest, WIN32)).toEqual({
        paths: [],
        skipped: 1,
      });
    });

    it("skips one without a drive on Windows", () => {
      expect(
        uriListPaths(`${RESOURCE_PREFIX}Users/me/a.png?1717171717171`, WIN32),
      ).toEqual({ paths: [], skipped: 1 });
    });

    it("skips one with an encoded backslash on Windows", () => {
      expect(
        uriListPaths(`${RESOURCE_PREFIX}C:/Users/me/a%5Cb.png?17`, WIN32),
      ).toEqual({ paths: [], skipped: 1 });
    });

    it("skips every one when Obsidian has no resource prefix", () => {
      expect(
        uriListPaths(`${RESOURCE_PREFIX}Users/me/a.png?1717171717171`, {
          fragments: false,
          platform: "darwin",
          resourcePrefix: "",
        }),
      ).toEqual({ paths: [], skipped: 1 });
    });

    it("still reads file URIs when Obsidian has no resource prefix", () => {
      expect(
        uriListPaths("file:///Users/me/a.png\nfile:///Users/me/b.png", {
          fragments: false,
          platform: "darwin",
          resourcePrefix: "",
        }),
      ).toEqual({ paths: ["/Users/me/a.png", "/Users/me/b.png"], skipped: 0 });
    });

    it("reads resource URLs and file URIs of one payload in order", () => {
      expect(
        uriListPaths(
          [
            `${RESOURCE_PREFIX}Users/me/a.png?1717171717171`,
            "file:///Users/me/b.png",
            `${RESOURCE_PREFIX}Users/me/c.png`,
          ].join("\r\n"),
          POSIX,
        ),
      ).toEqual({
        paths: ["/Users/me/a.png", "/Users/me/b.png", "/Users/me/c.png"],
        skipped: 0,
      });
    });
  });

  describe("with a large payload", () => {
    const uri = "file:///Users/me/a.png\n",
      // A comment line fills the payload up to the limit.
      atLimit = uri + "#".repeat(URI_LIST_LIMIT - uri.length),
      numbered = (count: number): readonly string[] =>
        Array.from(
          { length: count },
          (_, index) => `file:///vault/${String(index)}.png`,
        ),
      numberedPaths = (count: number): readonly string[] =>
        Array.from(
          { length: count },
          (_, index) => `/vault/${String(index)}.png`,
        );

    it("reads a payload of exactly 1 MiB", () => {
      expect(uriListPaths(atLimit, POSIX)).toEqual({
        paths: ["/Users/me/a.png"],
        skipped: 0,
      });
    });

    it("skips a payload over 1 MiB as a whole", () => {
      expect(uriListPaths(`${atLimit}#`, POSIX)).toEqual({
        paths: [],
        skipped: 1,
      });
    });

    it("reads exactly as many entries as the cap allows", () => {
      expect(
        uriListPaths(numbered(MAX_DROPPED_PATHS).join("\r\n"), POSIX),
      ).toEqual({ paths: numberedPaths(MAX_DROPPED_PATHS), skipped: 0 });
    });

    it("skips every entry after the cap, whatever it is", () => {
      expect(
        uriListPaths(
          [
            ...numbered(MAX_DROPPED_PATHS),
            "file:///Users/me/late.png",
            "https://example.com/late.png",
            "not a URI",
          ].join("\n"),
          POSIX,
        ),
      ).toEqual({ paths: numberedPaths(MAX_DROPPED_PATHS), skipped: 3 });
    });

    it("does not count comments and blank lines as entries", () => {
      expect(
        uriListPaths(
          numbered(MAX_DROPPED_PATHS)
            .map((entry) => `# comment\n\n${entry}`)
            .join("\n"),
          POSIX,
        ),
      ).toEqual({ paths: numberedPaths(MAX_DROPPED_PATHS), skipped: 0 });
    });

    it("counts an entry without a path as one of the entries under the cap", () => {
      expect(
        uriListPaths(
          ["https://example.com/a.png", ...numbered(MAX_DROPPED_PATHS)].join(
            "\n",
          ),
          POSIX,
        ),
      ).toEqual({ paths: numberedPaths(MAX_DROPPED_PATHS - 1), skipped: 2 });
    });
  });
});
