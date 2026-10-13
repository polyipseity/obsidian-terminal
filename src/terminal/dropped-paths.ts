/**
 * Paths dropped onto a terminal: which vault paths an Obsidian drag carries,
 * which local paths a dropped URI list names, and how a path is written for
 * the shell that reads it.
 *
 * Pure functions without DOM access or runtime imports, so they run in node.
 */
import type { Platform } from "@polyipseity/obsidian-plugin-library";

/**
 * How the program in a terminal reads a path as one argument.
 *
 * - `posix`: a POSIX shell on macOS or Linux, which takes backslash escapes.
 * - `posix-quoted`: a shell of the sh family on Windows, where paths hold
 *   backslashes.
 * - `wsl`: the Linux shell that `wsl.exe` starts on Windows, which finds a
 *   Windows file at its Linux path only.
 * - `powershell`: Windows PowerShell or PowerShell, on any platform.
 * - `cmd`: `cmd.exe`, and any other program on Windows.
 */
export type ShellGrammar =
  "posix" | "posix-quoted" | "wsl" | "powershell" | "cmd";

/** The paths one drop inserts at most; the rest is reported as skipped. */
export const MAX_DROPPED_PATHS = 1024;

/** Absolute paths found in a drop, and how many of its items gave none. */
export interface DroppedPaths {
  readonly paths: readonly string[];
  readonly skipped: number;
}

/** The texts to paste for dropped paths, and how many paths were left out. */
export interface DroppedPathTexts {
  readonly texts: readonly string[];
  readonly skipped: number;
}

export interface UriListOptions {
  /** Platform whose path syntax the result has. */
  readonly platform: Platform.All;
  /** `Platform.resourcePathPrefix` of Obsidian; empty if there is none. */
  readonly resourcePrefix: string;
  /**
   * Whether a `#` starts a fragment, which is left out. Visual Studio Code
   * encodes a `#` in a name and appends the place in the file as a fragment;
   * in any other list a `#` means that the name was not encoded.
   */
  readonly fragments: boolean;
}

const PATH_SEPARATOR = /[\\/]/u,
  // The suffix of a program or of the script that starts one, as in
  // `bash.exe` and `msys2_shell.cmd`.
  EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|com)$/u,
  // Windows PowerShell and PowerShell, without suffix. Exact names: a program
  // that merely starts with `pwsh` need not read arguments as PowerShell does.
  POWERSHELLS: ReadonlySet<string> = new Set([
    "powershell",
    "powershell_ise",
    "pwsh",
    "pwsh-preview",
  ]),
  // Shells that read no quotes as the sh family does: fish has `\\` and `\'`
  // as escapes inside single quotes, csh and tcsh expand `!` there, and all
  // three expand `$` (csh and tcsh backticks too) inside double quotes. They
  // read a backslash before a character as that character, on Windows too.
  ESCAPING_SHELLS: ReadonlySet<string> = new Set(["csh", "fish", "tcsh"]),
  // Programs that start a shell of the sh family on Windows, without suffix.
  WIN32_POSIX_SHELLS: ReadonlySet<string> = new Set([
    "ash",
    "bash",
    "busybox",
    "cygwin",
    "dash",
    "git-bash",
    "ksh",
    "mintty",
    "mksh",
    "msys2",
    "msys2_shell",
    "sh",
    "zsh",
  ]),
  // The program that starts a Linux shell on Windows, without suffix.
  WSL = "wsl",
  // Characters a POSIX shell reads literally: everything else in ASCII gets a
  // backslash. Non-ASCII characters are not special to a shell and stay as-is.
  // No shell needs the colon escaped; Claude Code does (see `escapePosix`).
  POSIX_ESCAPED = /[^A-Za-z0-9/._+@\u0080-\u{10FFFF}-]/gu,
  // A slash after a space: one of the two places where Claude Code cuts a
  // paste into several paths.
  SPACE_SLASH = / \//gu,
  SINGLE_QUOTE = /'/gu,
  // What a shell of the sh family does not read as it is inside double
  // quotes: `$`, a backtick, `"` and `!` (history), two backslashes (read as
  // one), and a backslash at the end (it would escape the closing quote).
  SH_DOUBLE_QUOTED_SPECIAL = /[$`"!]|\\\\|\\$/u,
  // Paths made only of these need no quotes in PowerShell or `cmd.exe`:
  // letters, digits and combining marks of any script, and `\ / . _ : ~ + -`.
  PLAIN = /^[A-Za-z0-9\\/._:~+\p{L}\p{N}\p{M}-]*$/u,
  // PowerShell reads the curly quotes as it reads the straight ones: these
  // end a single-quoted string...
  POWERSHELL_SINGLE_QUOTES = /['\u2018\u2019\u201a\u201b]/gu,
  // ...and these are special inside a double-quoted one.
  POWERSHELL_DOUBLE_QUOTED_SPECIAL = /[$`"\u201c\u201d\u201e]/u,
  // The backslashes at the end of a Windows path, with the character before
  // them. After a colon they make a root (`C:\`), which is not matched.
  TRAILING_BACKSLASHES = /([^\\:])\\+$/u,
  // The backslashes a path ends in, those of a root included.
  BACKSLASHES_AT_END = /\\+$/u,
  // Control characters: C0 is U+0000-U+001F; DEL and C1 are U+007F-U+009F.
  C0_END = 0x20,
  DEL = 0x7f,
  C1_END = 0xa0,
  // 1 MiB, in UTF-16 code units.
  URI_LIST_MAX_LENGTH = 2 ** 20,
  LINE_BREAK = /\r\n|\r|\n/u,
  // The modification time Obsidian appends to a resource URL.
  RESOURCE_MTIME = /\?\d+$/u,
  URI_QUERY_OR_FRAGMENT = /[?#]/u,
  // `file:` with a path. `file:` alone and `file:name` are relative, and the
  // URL parser makes an absolute path of them.
  FILE_URI = /^file:\//iu,
  ENCODED_SLASH = /%2f/iu,
  ENCODED_SLASH_OR_BACKSLASH = /%(?:2f|5c)/iu,
  WIN32_DRIVE_PATHNAME = /^\/[A-Za-z]:\//u,
  SLASH = /\//gu,
  BACKSLASH = /\\/gu,
  // A Windows path on a drive: the letter, and what follows the root. The
  // rest is taken whole (`s`): a name may hold a line separator of Unicode.
  WIN32_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/su,
  // A path into the files of a WSL distribution, as Windows shows them:
  // `\\wsl.localhost\<distribution>`, or `\\wsl$\<distribution>` as it was
  // before, and what follows it.
  WSL_SHARE_PATH = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+[^\\/]+(.*)$/isu,
  // Two separators at the start: a network share, or a device path.
  WIN32_UNC_PATH = /^[\\/]{2}/u;

/** Narrows to a non-array object that has `key`, own or inherited. */
function hasProperty<K extends string>(
  value: unknown,
  key: K,
): value is Readonly<Record<K, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    key in value
  );
}

/** `Array.isArray` narrows `unknown` to `any[]`; this keeps the elements `unknown`. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** The non-empty `path` of a file-like object (`TFile`, `TFolder`, bookmark item). */
function pathOf(value: unknown): string | null {
  if (!hasProperty(value, "path")) {
    return null;
  }
  const { path } = value;
  return typeof path === "string" && path !== "" ? path : null;
}

/** The item of a bookmark entry if it points at a file or folder, not at a group, search, URL... */
function bookmarkedFile(entry: unknown): unknown {
  if (!hasProperty(entry, "item")) {
    return null;
  }
  const { item } = entry;
  return hasProperty(item, "type") &&
    (item.type === "file" || item.type === "folder")
    ? item
    : null;
}

/** The file-like objects a drag carries, unchecked. */
function draggedFiles(draggable: unknown): readonly unknown[] {
  if (!hasProperty(draggable, "type")) {
    return [];
  }
  switch (draggable.type) {
    // All three carry their target in `file`, which is `null` for an unresolved link.
    case "file":
    case "folder":
    case "link":
      return hasProperty(draggable, "file") ? [draggable.file] : [];
    case "files":
      return hasProperty(draggable, "files") && isArray(draggable.files)
        ? draggable.files
        : [];
    case "bookmarks":
      return hasProperty(draggable, "items") && isArray(draggable.items)
        ? draggable.items.map(bookmarkedFile)
        : [];
    // A card of a Bases board keeps its note one level down.
    case "kanban-card":
      return hasProperty(draggable, "entry") &&
        hasProperty(draggable.entry, "file")
        ? [draggable.entry.file]
        : [];
    default:
      // Headings, properties and other drags have no file to insert.
      return [];
  }
}

/**
 * Returns the vault-relative paths carried by the draggable of Obsidian's drag
 * manager, in drag order and without duplicates.
 *
 * The draggable is not part of Obsidian's API, so its shape is checked at
 * every step: anything unexpected yields no path instead of an error.
 *
 * @param draggable - `app.dragManager.draggable`, of any shape.
 * @returns paths of the dragged files and folders; empty for an unsupported
 * drag, and for one that cannot be read. Never throws.
 */
export function vaultDragPaths(draggable: unknown): readonly string[] {
  try {
    const paths = new Set<string>();
    for (const file of draggedFiles(draggable)) {
      const path = pathOf(file);
      if (path !== null) {
        paths.add(path);
      }
    }
    return [...paths];
  } catch {
    // Reading an object can run its code: a getter that throws, a revoked
    // proxy. The callers are drag event listeners, where an error would leave
    // the drag half handled, so such a drag carries no path.
    return [];
  }
}

/**
 * Tells how the shell of a terminal reads a path, from the shell's executable.
 *
 * Windows has no grammar that every shell shares: `cmd.exe` knows double
 * quotes only, PowerShell expands `$` and backticks inside them, a shell of
 * the sh family takes the backslashes of a Windows path for escapes, and the
 * Linux shell that `wsl.exe` starts does not find a Windows path at all. A
 * program that is not recognized gets double quotes there, which
 * Explorer-style terminals write and Claude Code reads. fish, csh and tcsh
 * read neither kind of quotes as written, so their paths are escaped as on
 * other platforms, backslashes of the path included.
 *
 * The shell is known by the exact name of the executable, in any case and
 * without one suffix of a Windows program or script (`.exe`, `.cmd`, `.bat`,
 * `.com`).
 *
 * @param executable - executable of the profile, as a name or a path.
 * @param platform - platform the terminal runs on.
 * @returns the grammar to write paths in.
 */
export function shellGrammar(
  executable: string,
  platform: Platform.All,
): ShellGrammar {
  const name = (executable.split(PATH_SEPARATOR).at(-1) ?? "")
    .toLowerCase()
    .replace(EXECUTABLE_SUFFIX, "");
  if (POWERSHELLS.has(name)) {
    return "powershell";
  }
  if (platform !== "win32" || ESCAPING_SHELLS.has(name)) {
    return "posix";
  }
  if (name === WSL) {
    return "wsl";
  }
  return WIN32_POSIX_SHELLS.has(name) ? "posix-quoted" : "cmd";
}

/**
 * A file name must never send Enter, Escape or another control input to the
 * program in the terminal: a pasted newline arrives as a carriage return,
 * which runs the line when the program has no bracketed paste.
 *
 * The C1 control characters count as well. A shell that echoes them as they
 * are (bash does) has xterm.js run them: U+009B is `ESC [` in one character,
 * so a name can hold a request that the terminal answers with input.
 */
function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; ++index) {
    const code = path.charCodeAt(index);
    if (code < C0_END || (code >= DEL && code < C1_END)) {
      return true;
    }
  }
  return false;
}

/**
 * Quotes for a shell of the sh family (bash, sh, zsh, dash, ksh) on Windows.
 *
 * Never bare: the shell would take the backslashes out of a Windows path.
 * Single quotes are the safe ones, as everything inside them is read as it
 * is. Claude Code takes one pair of quotes off a pasted path and nothing
 * more, so a path with a single quote goes in double quotes while it can:
 * the shell keeps a single backslash inside them.
 */
function quoteSh(path: string): string {
  if (!path.includes("'")) {
    return `'${path}'`;
  }
  return SH_DOUBLE_QUOTED_SPECIAL.test(path)
    ? // A single quote cannot be written inside: close, escape one, reopen.
      `'${path.replace(SINGLE_QUOTE, "'\\''")}'`
    : `"${path}"`;
}

/**
 * Backslashes for a POSIX shell, as macOS Terminal, iTerm2 and Ghostty write
 * dropped files.
 *
 * bash, sh, zsh, dash, ksh, fish and tcsh all read a backslash before
 * punctuation as that character, while each reads quotes in its own way.
 * Letters and digits are never escaped, so fish's `\n`-style escapes cannot be
 * produced.
 *
 * Claude Code cuts a paste at a space followed by `/` or by a drive prefix (a
 * letter, `:` and a backslash), which the backslash of an escaped space makes
 * of ` B: ` in a name. So every colon gets a backslash as well, and so does a
 * slash after a space: nothing is left to cut at.
 */
function escapePosix(path: string): string {
  // The space is `\ ` by now; the slash after it gets a backslash as well.
  return path.replace(POSIX_ESCAPED, "\\$&").replace(SPACE_SLASH, " \\/");
}

/**
 * The path at which a Linux program under WSL finds a Windows file.
 *
 * WSL mounts each drive under `/mnt`, by its letter in lower case. The files
 * of a distribution, which Windows shows under `\\wsl.localhost` (`\\wsl$`
 * before), are at its root. Windows Terminal converts dropped paths the same
 * way.
 *
 * Three limits. `/mnt` is where the drives are unless `/etc/wsl.conf` of the
 * distribution names another place. A drive that WSL has not mounted, as a
 * removable or a network drive may be, has no file at its path. And a path
 * into a distribution is taken for one into the distribution of the
 * terminal, which the executable of the profile does not tell.
 *
 * @param path - absolute path, as Windows writes it.
 * @returns the Linux path; a path that is one already as it is; `null` for a
 * path with no place under WSL, such as one on a network share.
 */
function wslPath(path: string): string | null {
  const [, underDistribution] = WSL_SHARE_PATH.exec(path) ?? [];
  if (typeof underDistribution === "string") {
    const linux = underDistribution.replace(BACKSLASH, "/");
    // The distribution alone is its root.
    return linux === "" ? "/" : linux;
  }
  const [, drive, underDrive] = WIN32_DRIVE_PATH.exec(path) ?? [];
  if (typeof drive === "string" && typeof underDrive === "string") {
    return `/mnt/${drive.toLowerCase()}/${underDrive.replace(BACKSLASH, "/")}`;
  }
  return path.startsWith("/") && !WIN32_UNC_PATH.test(path) ? path : null;
}

/**
 * Writes a path for the Linux shell that `wsl.exe` starts: as its Linux path
 * (see {@link wslPath}), escaped as for any shell on Linux. Claude Code
 * there is the Linux program, and reads the path as it does on Linux.
 */
function escapeWsl(path: string): string | null {
  const linux = wslPath(path);
  return linux === null ? null : escapePosix(linux);
}

/**
 * Takes the backslashes off the end of a Windows path that goes in quotes: a
 * program that reads its command line by the rules of the Microsoft C runtime
 * takes `\"` for an escaped quote, and the argument would not end there. A
 * root (`C:\`) keeps its backslash, without which it is another place.
 */
function withoutTrailingBackslashes(path: string): string {
  return path.replace(TRAILING_BACKSLASHES, "$1");
}

/**
 * Puts a Windows path in double quotes, after its backslashes at the end
 * were taken off. Those a root still ends in are written twice: a program
 * that reads its command line by the rules of the Microsoft C runtime reads
 * two before a quote as one and the quote as the end, where `\"` would take
 * the next dropped path into this argument.
 */
function doubleQuoteWin32(path: string): string {
  return `"${path.replace(BACKSLASHES_AT_END, "$&$&")}"`;
}

/**
 * Quotes for PowerShell.
 *
 * Single quotes are the safe ones, as double quotes expand `$` and backticks.
 * Claude Code takes one pair of quotes off a pasted path and nothing more, so
 * a path with a single quote goes in double quotes while it can: doubling the
 * quote is what PowerShell wants, but Claude Code then no longer sees a path.
 */
function quotePowerShell(path: string): string {
  // PowerShell on macOS or Linux, where a backslash is part of a name, not a
  // separator: it is quoted like any other unusual character, and it is
  // neither taken off the end nor written twice there.
  const posix = path.startsWith("/");
  if (PLAIN.test(path) && !(posix && path.includes("\\"))) {
    return path;
  }
  const quoted = posix ? path : withoutTrailingBackslashes(path),
    // Each quote is doubled as itself: PowerShell keeps the second of a pair.
    doubled = quoted.replace(POWERSHELL_SINGLE_QUOTES, "$&$&");
  if (doubled === quoted) {
    return `'${quoted}'`;
  }
  if (POWERSHELL_DOUBLE_QUOTED_SPECIAL.test(quoted)) {
    return `'${doubled}'`;
  }
  return posix ? `"${quoted}"` : doubleQuoteWin32(quoted);
}

/** Double quotes for `cmd.exe`, the only quotes it knows. */
function quoteCmd(path: string): string | null {
  if (PLAIN.test(path)) {
    return path;
  }
  // `cmd.exe` cannot escape a double quote, and no Windows file has one.
  return path.includes('"')
    ? null
    : doubleQuoteWin32(withoutTrailingBackslashes(path));
}

/**
 * Writes a path as one argument for a shell.
 *
 * @param path - absolute path.
 * @param grammar - how the shell in the terminal reads arguments.
 * @returns the argument, without a space after it; `null` for an empty path,
 * a path with a control character (C0, DEL or C1), and a path the shell has
 * no way to write.
 */
export function formatDroppedPath(
  path: string,
  grammar: ShellGrammar,
): string | null {
  if (path === "" || hasControlCharacter(path)) {
    return null;
  }
  switch (grammar) {
    case "posix":
      return escapePosix(path);
    case "posix-quoted":
      return quoteSh(path);
    case "wsl":
      return escapeWsl(path);
    case "powershell":
      return quotePowerShell(path);
    case "cmd":
      return quoteCmd(path);
  }
}

/**
 * Formats dropped paths as the texts to paste into a terminal.
 *
 * Each path is a text of its own, as some terminals need each pasted on its
 * own (see {@link droppedPathPastes}). A text ends with a space, as native
 * terminals write it, so that the next path or typed text does not join it.
 *
 * Duplicates are removed, keeping the first. Paths that cannot be written
 * (see {@link formatDroppedPath}) and distinct paths after the first
 * {@link MAX_DROPPED_PATHS} texts are counted as skipped.
 *
 * @param paths - absolute paths, in the order to insert them.
 * @param grammar - how the shell in the terminal reads arguments.
 * @returns the texts to paste, in order, and the number of skipped paths.
 */
export function formatDroppedPaths(
  paths: readonly string[],
  grammar: ShellGrammar,
): DroppedPathTexts {
  const seen = new Set<string>(),
    texts: string[] = [];
  let skipped = 0;
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const text =
      texts.length < MAX_DROPPED_PATHS
        ? formatDroppedPath(path, grammar)
        : null;
    if (text === null) {
      ++skipped;
    } else {
      texts.push(`${text} `);
    }
  }
  return { skipped, texts };
}

/**
 * Puts the texts of dropped paths into the pastes that insert them.
 *
 * One paste holds them all, except on Windows. Each paste is a bracketed
 * paste of its own, after which a shell redraws its line, and a burst of them
 * can stall the shell against the pty proxy for good: the proxy does not read
 * the shell's output while it writes its input. A shell reads one paste in
 * one go, and Claude Code tells the escaped paths in it apart, as it cuts a
 * paste at a space followed by `/`.
 *
 * On Windows each text is a paste of its own: a path with a space is quoted
 * there, and Claude Code attaches several quoted paths only when each arrives
 * as a separate paste. Terminals there do not go through the proxy. The
 * escaped paths of a WSL terminal go the same way: the platform decides
 * here, not the shell, and a paste for each path loses them nothing.
 *
 * @param texts - texts of {@link formatDroppedPaths}, each ending in a space.
 * @param platform - platform the terminal runs on.
 * @returns the texts to paste, in order; none for no texts.
 */
export function droppedPathPastes(
  texts: readonly string[],
  platform: Platform.All,
): readonly string[] {
  if (platform === "win32") {
    return texts;
  }
  // Never a paste of nothing. The space each text ends in is all that is
  // needed between two of them.
  return texts.length === 0 ? [] : [texts.join("")];
}

/** `new URL` that returns `null` for an invalid URL. */
function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** `decodeURIComponent` that returns `null` for a malformed escape. */
function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Rewrites an Obsidian resource URL (the `src` of an embedded image) as the
 * `file:` URI it was made from; any other line is returned as it is.
 */
function resourceUri(line: string, resourcePrefix: string): string {
  // An empty prefix would claim every line.
  return resourcePrefix !== "" && line.startsWith(resourcePrefix)
    ? `file:///${line.slice(resourcePrefix.length).replace(RESOURCE_MTIME, "")}`
    : line;
}

/**
 * The local path a `file:` URI names; `null` for any other URI and for one
 * that leaves a doubt about the path.
 */
function fileUriPath(uri: string, platform: Platform.All): string | null {
  // A `?` or `#` that is part of a name comes encoded. A raw one means the
  // producer did not encode the name, and the URL parser would cut it there.
  // A relative URI is not read either: it has no place to be relative to.
  if (!FILE_URI.test(uri) || URI_QUERY_OR_FRAGMENT.test(uri)) {
    return null;
  }
  const url = parseUrl(uri);
  // A host other than this machine is a network share, which is never opened.
  // `localhost` is compared as well: the URL parser of Chromium keeps that
  // host of a `file:` URI, where the one of Node reads it as none.
  if (url === null || (url.hostname !== "" && url.hostname !== "localhost")) {
    return null;
  }
  const { pathname } = url,
    win32 = platform === "win32";
  // The URL parser reads a raw backslash as a slash. Off Windows that is a
  // character of a name, which comes encoded from a producer that encodes.
  if (!win32 && uri.includes("\\")) {
    return null;
  }
  // An encoded separator decodes into a path the URI did not have.
  if ((win32 ? ENCODED_SLASH_OR_BACKSLASH : ENCODED_SLASH).test(pathname)) {
    return null;
  }
  const path = decode(pathname);
  if (path === null) {
    return null;
  }
  if (win32) {
    // Drive paths only: `//server/share` is a network share. The drive is
    // written in upper case, as Windows does; Visual Studio Code has `c%3A`.
    return WIN32_DRIVE_PATHNAME.test(path)
      ? path.charAt(1).toUpperCase() + path.slice(2).replace(SLASH, "\\")
      : null;
  }
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

/** The local path one entry of a URI list names; `null` if it names none. */
function entryPath(entry: string, options: UriListOptions): string | null {
  // The URL parser takes tabs out of a URL and control characters off its
  // ends, without a word: what is left names another path.
  if (hasControlCharacter(entry)) {
    return null;
  }
  const { fragments, platform, resourcePrefix } = options,
    hash = fragments ? entry.indexOf("#") : -1,
    uri = hash === -1 ? entry : entry.slice(0, hash);
  // It takes a space off the end as well, and one before the fragment is
  // at the end now.
  return uri.endsWith(" ")
    ? null
    : fileUriPath(resourceUri(uri, resourcePrefix), platform);
}

/**
 * Reads the absolute local paths out of a `text/uri-list` drop payload, in
 * order. Duplicates are kept, and the file system is never touched: a path is
 * not checked for existence, and a network location is not resolved.
 *
 * `file:` URIs of this machine and Obsidian resource URLs give a path. Every
 * other entry counts as skipped, as does each entry after the first
 * {@link MAX_DROPPED_PATHS} and a payload over 1 MiB as a whole. An entry
 * with a control character, white space at an end, a query, or a fragment
 * where the list has none (see {@link UriListOptions.fragments}) is skipped
 * as well: what it names is in doubt.
 *
 * @param text - the payload: one URI per line, `#` starting a comment line.
 * @param options - how to read the URIs: platform, resource URL prefix, and
 * whether they have fragments.
 * @returns the paths, and the number of entries that gave none.
 */
export function uriListPaths(
  text: string,
  options: UriListOptions,
): DroppedPaths {
  if (text.length > URI_LIST_MAX_LENGTH) {
    return { paths: [], skipped: 1 };
  }
  const paths: string[] = [];
  let entries = 0,
    skipped = 0;
  for (const line of text.split(LINE_BREAK)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    // White space at an end of a URI is not trimmed away: a source that
    // encodes names leaves none there, and the URI without it names another
    // path than the one that was dragged.
    const path =
      ++entries > MAX_DROPPED_PATHS || trimmed !== line
        ? null
        : entryPath(line, options);
    if (path === null) {
      ++skipped;
    } else {
      paths.push(path);
    }
  }
  return { paths, skipped };
}
