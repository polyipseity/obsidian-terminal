/**
 * Minimal Obsidian runtime mock for plugin tests.
 * Provides compile-time API surface parity with obsidian.d.ts and useful runtime behavior.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ===== Core Types =====

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export interface TFile extends TAbstractFile {
  path: string;
  name: string;
  extension: string;
  basename: string;
  stat: FileStats;
  parent: TFolder | null;
  vault: Vault;
}

export interface TFolder extends TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null;
  children: (TFile | TFolder)[];
  vault: Vault;
  isRoot(): boolean;
}

export interface TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null;
  vault: Vault;
}

export type CachedMetadata = {
  frontmatter?: Record<string, unknown>;
  links?: Array<{ link: string; original: string; displayText: string }>;
  headings?: Array<{ heading: string; level: number }>;
  sections?: Array<{
    type: string;
    position: {
      start: { line: number; col: number; offset: number };
      end: { line: number; col: number; offset: number };
    };
  }>;
  tags?: Array<{
    tag: string;
    position: {
      start: { line: number; col: number; offset: number };
      end: { line: number; col: number; offset: number };
    };
  }>;
};

export interface EditorPosition {
  line: number;
  ch: number;
}

export interface EditorRange {
  from: EditorPosition;
  to: EditorPosition;
}

export interface EditorSelection extends EditorRange {
  anchor: EditorPosition;
  head: EditorPosition;
}

export interface EditorTransaction {
  replaceRange?: { from: EditorPosition; to: EditorPosition; text: string };
  setSelection?: EditorSelection;
}

export interface RequestUrlParam {
  url: string;
  method?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  contentType?: string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

// ===== Internal State =====

const state: {
  files: Map<string, { content: string; stat: FileStats }>;
  editors: Editor[];
  icons: Map<string, string>;
  requestHandler:
    | ((param: RequestUrlParam) => Promise<RequestUrlResponse>)
    | null;
  requestStubs: {
    matcher: string | RegExp;
    response: RequestUrlResponse | (() => RequestUrlResponse);
  }[];
  requestCalls: { url: string; param: RequestUrlParam }[];
  vaultConfig: Map<string, unknown>;
  keymapScopes: Scope[];
  pluginData: Map<Plugin, unknown>;
} = {
  files: new Map<string, { content: string; stat: FileStats }>(),
  editors: [],
  icons: new Map<string, string>(),
  requestHandler: null,
  requestStubs: [],
  requestCalls: [],
  vaultConfig: new Map<string, unknown>(),
  keymapScopes: [],
  pluginData: new Map<Plugin, unknown>(),
};

// ===== Events =====

export interface EventRef {
  __eventRef: true;
  listener: (...args: unknown[]) => unknown;
}

export class Events {
  private listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();

  on(
    name: string,
    callback: (...args: unknown[]) => unknown,
    ctx?: unknown,
  ): EventRef {
    const bound = ctx ? callback.bind(ctx) : callback;
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set<(...args: unknown[]) => unknown>();
      this.listeners.set(name, set);
    }
    set.add(bound);
    return { __eventRef: true, listener: bound };
  }

  off(name: string, callback: (...args: unknown[]) => unknown): void {
    this.listeners.get(name)?.delete(callback);
  }

  offref(ref: EventRef): void {
    for (const listeners of this.listeners.values()) {
      listeners.delete(ref.listener);
    }
  }

  trigger(name: string, ...args: unknown[]): void {
    this.listeners.get(name)?.forEach((cb) => cb(...args));
  }

  tryTrigger(
    evt: { defaultPrevented: boolean },
    name: string,
    ...args: unknown[]
  ): void {
    if (!evt.defaultPrevented) {
      this.trigger(name, ...args);
    }
  }
}

// ===== Vault =====

export class Vault extends Events {
  adapter = {
    getName: (): string => "mock-adapter",
    exists: async (path: string): Promise<boolean> =>
      state.files.has(normalizePath(path)),
    read: async (path: string): Promise<string> => {
      const file = state.files.get(normalizePath(path));
      if (!file) throw new Error(`File not found: ${path}`);
      return file.content;
    },
    write: async (path: string, data: string): Promise<void> => {
      const normalized = normalizePath(path);
      const existing = state.files.get(normalized);
      const now = Date.now();
      state.files.set(normalized, {
        content: data,
        stat: existing?.stat ?? { ctime: now, mtime: now, size: data.length },
      });
      if (existing) {
        existing.stat.mtime = now;
        existing.stat.size = data.length;
      }
    },
  };

  getName(): string {
    return "Mock Vault";
  }

  getRoot(): TFolder {
    return {
      path: "/",
      name: "",
      parent: null,
      children: [],
      vault: this,
      isRoot: () => true,
    };
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const normalized = normalizePath(path);
    if (!state.files.has(normalized)) return null;
    return this.makeFile(normalized);
  }

  getFileByPath(path: string): TFile | null {
    return this.getAbstractFileByPath(path) as TFile | null;
  }

  getMarkdownFiles(): TFile[] {
    const files: TFile[] = [];
    for (const [path] of state.files) {
      if (path.endsWith(".md")) {
        files.push(this.makeFile(path));
      }
    }
    return files;
  }

  getFiles(): TFile[] {
    const files: TFile[] = [];
    for (const [path] of state.files) {
      files.push(this.makeFile(path));
    }
    return files;
  }

  async create(path: string, data: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (state.files.has(normalized)) {
      throw new Error(`File already exists: ${path}`);
    }
    const now = Date.now();
    state.files.set(normalized, {
      content: data,
      stat: { ctime: now, mtime: now, size: data.length },
    });
    const file = this.makeFile(normalized);
    this.trigger("create", file);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    return {
      path: normalizePath(path),
      name: path.split("/").pop() ?? "",
      parent: null,
      children: [],
      vault: this,
      isRoot: () => false,
    };
  }

  async read(file: TFile | string): Promise<string> {
    const path = typeof file === "string" ? file : file.path;
    const normalized = normalizePath(path);
    const data = state.files.get(normalized);
    if (!data) throw new Error(`File not found: ${path}`);
    return data.content;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async readBinary(file: TFile | string): Promise<ArrayBuffer> {
    const content = await this.read(file);
    const encoder = new TextEncoder();
    return encoder.encode(content).buffer;
  }

  async modify(file: TFile | string, data: string): Promise<void> {
    const path = typeof file === "string" ? file : file.path;
    const normalized = normalizePath(path);
    const existing = state.files.get(normalized);
    if (!existing) throw new Error(`File not found: ${path}`);
    const now = Date.now();
    existing.content = data;
    existing.stat.mtime = now;
    existing.stat.size = data.length;
    const fileObj = this.makeFile(normalized);
    this.trigger("modify", fileObj);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async delete(file: TFile | string, _force?: boolean): Promise<void> {
    const path = typeof file === "string" ? file : file.path;
    const normalized = normalizePath(path);
    if (!state.files.has(normalized)) {
      throw new Error(`File not found: ${path}`);
    }
    const fileObj = this.makeFile(normalized);
    state.files.delete(normalized);
    this.trigger("delete", fileObj);
  }

  async rename(file: TFile | string, newPath: string): Promise<void> {
    const oldPath = typeof file === "string" ? file : file.path;
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const data = state.files.get(normalizedOld);
    if (!data) throw new Error(`File not found: ${oldPath}`);
    if (state.files.has(normalizedNew)) {
      throw new Error(`File already exists: ${newPath}`);
    }
    state.files.set(normalizedNew, data);
    state.files.delete(normalizedOld);
    const newFile = this.makeFile(normalizedNew);
    this.trigger("rename", newFile, oldPath);
  }

  async copy(file: TFile | string, newPath: string): Promise<TFile> {
    const oldPath = typeof file === "string" ? file : file.path;
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const data = state.files.get(normalizedOld);
    if (!data) throw new Error(`File not found: ${oldPath}`);
    if (state.files.has(normalizedNew)) {
      throw new Error(`File already exists: ${newPath}`);
    }
    const now = Date.now();
    state.files.set(normalizedNew, {
      content: data.content,
      stat: { ...data.stat, ctime: now },
    });
    return this.makeFile(normalizedNew);
  }

  async process(
    file: TFile | string,
    fn: (data: string) => string,
  ): Promise<string> {
    const content = await this.read(file);
    const newContent = fn(content);
    await this.modify(file, newContent);
    return newContent;
  }

  async append(file: TFile | string, data: string): Promise<void> {
    const content = await this.read(file);
    await this.modify(file, content + data);
  }

  getConfig(key: string): unknown {
    return state.vaultConfig.get(key) ?? null;
  }

  setConfig(key: string, value: unknown): void {
    state.vaultConfig.set(key, value);
  }

  on(
    name: "create" | "modify" | "delete",
    callback: (file: TAbstractFile) => unknown,
    ctx?: unknown,
  ): EventRef;
  on(
    name: "rename",
    callback: (file: TAbstractFile, oldPath: string) => unknown,
    ctx?: unknown,
  ): EventRef;

  on(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (...args: any[]) => unknown,
    ctx?: unknown,
  ): EventRef {
    return super.on(name, callback, ctx);
  }

  private makeFile(path: string): TFile {
    const data = state.files.get(path);
    if (!data) throw new Error(`File not found: ${path}`);
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "";
    const extIdx = name.lastIndexOf(".");
    return {
      path,
      name,
      extension: extIdx >= 0 ? name.slice(extIdx + 1) : "",
      basename: extIdx >= 0 ? name.slice(0, extIdx) : name,
      stat: data.stat,
      parent: null,
      vault: this,
    };
  }
}

// ===== FileManager =====

export class FileManager {
  constructor(private vault: Vault) {}

  async renameFile(file: TFile, newPath: string): Promise<void> {
    await this.vault.rename(file, newPath);
  }

  async generateMarkdownLink(
    file: TFile,
    _sourcePath: string,
    subpath?: string,
    alias?: string,
  ): Promise<string> {
    return `[[${file.path}${subpath ?? ""}${alias ? `|${alias}` : ""}]]`;
  }

  /**
   * Minimal implementation of FileManager.processFrontMatter used by library
   * helpers. Calls the provided synchronous processor with the parsed frontmatter
   * object and writes back the file when the processor mutates it.
   */
  async processFrontMatter(
    file: TFile,
    fn: (fm: Record<string, unknown>) => void,
    // options ignored in the mock but accepted for signature parity
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options?: unknown,
  ): Promise<void> {
    const content = await this.vault.read(file);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

    // Parse original frontmatter when present; tolerate parse errors.
    let originalFmObj: Record<string, unknown> | null = null;
    let parseFailed = false;
    if (fmMatch) {
      try {
        const parsed = parseYaml(fmMatch[1] ?? "");
        // Treat non-object YAML results (strings, arrays, etc.) as parse failures
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          originalFmObj = parsed;
        } else {
          parseFailed = true;
          originalFmObj = null;
        }
      } catch {
        parseFailed = true;
        originalFmObj = null;
      }
    }

    // Start with a shallow clone of the original object (or empty when absent)
    const currentFm: Record<string, unknown> = originalFmObj
      ? JSON.parse(JSON.stringify(originalFmObj))
      : {};

    // Call the provided processor (synchronous in real API)
    fn(currentFm);

    // Determine whether the processor actually changed the frontmatter.
    const fmIsEmpty = Object.keys(currentFm).length === 0;

    // If there was no original frontmatter and processor left it empty -> no write
    if (!fmMatch && fmIsEmpty) return;

    // If original parsed successfully and objects are deeply equal -> no write
    if (fmMatch && !parseFailed) {
      if (JSON.stringify(originalFmObj) === JSON.stringify(currentFm)) return;
    }

    // If original was malformed and processor didn't change anything -> don't overwrite
    if (fmMatch && parseFailed && fmIsEmpty) return;

    // Otherwise serialize and write the updated frontmatter
    const newFmRaw = stringifyYaml(currentFm ?? {}) ?? "";
    const newFrontMatter = `---\n${newFmRaw}\n---`;
    let newContent: string;
    if (fmMatch) {
      newContent = content.replace(/^---\n([\s\S]*?)\n---/, newFrontMatter);
    } else {
      newContent = `${newFrontMatter}\n${content}`;
    }

    if (newContent !== content) {
      await this.vault.modify(file, newContent);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getNewFileParent(_sourcePath: string): TFolder {
    return this.vault.getRoot();
  }
}

// ===== Editor =====

export class Editor {
  private content: string;
  private selection: EditorSelection;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(content = "") {
    this.content = content;
    this.selection = {
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 0 },
      anchor: { line: 0, ch: 0 },
      head: { line: 0, ch: 0 },
    };
  }

  getValue(): string {
    return this.content;
  }

  setValue(content: string): void {
    this.undoStack.push(this.content);
    this.redoStack = [];
    this.content = content;
  }

  getLine(line: number): string {
    const lines = this.content.split("\n");
    return lines[line] ?? "";
  }

  lineCount(): number {
    return this.content.split("\n").length;
  }

  lastLine(): number {
    return this.lineCount() - 1;
  }

  getSelection(): string {
    const from = this.posToOffset(this.selection.from);
    const to = this.posToOffset(this.selection.to);
    return this.content.slice(from, to);
  }

  setSelection(from: EditorPosition, to?: EditorPosition): void {
    this.selection = {
      from,
      to: to ?? from,
      anchor: from,
      head: to ?? from,
    };
  }

  getCursor(type?: "from" | "to" | "head" | "anchor"): EditorPosition {
    switch (type) {
      case "from":
        return this.selection.from;
      case "to":
        return this.selection.to;
      case "head":
        return this.selection.head;
      case "anchor":
        return this.selection.anchor;
      default:
        return this.selection.head;
    }
  }

  setCursor(pos: EditorPosition | number, ch?: number): void {
    const position = typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : pos;
    this.setSelection(position, position);
  }

  replaceRange(
    replacement: string,
    from: EditorPosition,
    to?: EditorPosition,
  ): void {
    this.undoStack.push(this.content);
    this.redoStack = [];
    const fromOffset = this.posToOffset(from);
    const toOffset = to ? this.posToOffset(to) : fromOffset;
    this.content =
      this.content.slice(0, fromOffset) +
      replacement +
      this.content.slice(toOffset);
  }

  replaceSelection(replacement: string): void {
    this.replaceRange(replacement, this.selection.from, this.selection.to);
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    const fromOffset = this.posToOffset(from);
    const toOffset = this.posToOffset(to);
    return this.content.slice(fromOffset, toOffset);
  }

  posToOffset(pos: EditorPosition): number {
    const lines = this.content.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) {
      const ln = lines[i] ?? "";
      offset += ln.length + 1;
    }
    return offset + pos.ch;
  }

  offsetToPos(offset: number): EditorPosition {
    const lines = this.content.split("\n");
    let remaining = offset;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = (lines[i] ?? "").length;
      if (remaining <= lineLen) {
        return { line: i, ch: remaining };
      }
      remaining -= lineLen + 1;
    }
    return { line: lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 };
  }

  transaction(tx: EditorTransaction): void {
    if (tx.replaceRange) {
      this.replaceRange(
        tx.replaceRange.text,
        tx.replaceRange.from,
        tx.replaceRange.to,
      );
    }
    if (tx.setSelection) {
      this.selection = tx.setSelection;
    }
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev !== undefined) {
      this.redoStack.push(this.content);
      this.content = prev;
    }
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next !== undefined) {
      this.undoStack.push(this.content);
      this.content = next;
    }
  }

  focus(): void {}
  blur(): void {}
  hasFocus(): boolean {
    return false;
  }
  getScrollInfo(): { top: number; left: number } {
    return { top: 0, left: 0 };
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  scrollTo(_x?: number, _y?: number): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  scrollIntoView(_range: EditorRange, _center?: boolean): void {}
}

// ===== MetadataCache =====

export class MetadataCache extends Events {
  private cache = new Map<string, CachedMetadata>();

  constructor(private vault: Vault) {
    super();
    vault.on("create", (file: TAbstractFile) => this.updateCache(file.path));
    vault.on("modify", (file: TAbstractFile) => this.updateCache(file.path));
    vault.on("delete", (file: TAbstractFile) =>
      this.cache.delete(normalizePath(file.path)),
    );
  }

  getCache(path: string): CachedMetadata | null {
    const normalized = normalizePath(path);
    if (!this.cache.has(normalized)) {
      this.updateCache(normalized);
    }
    return this.cache.get(normalized) ?? null;
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.getCache(file.path);
  }

  private updateCache(path: string): void {
    // Prefer synchronous cache updates for the mock so callers can read metadata
    // immediately after `setVaultFiles` or vault operations in tests.
    const normalized = normalizePath(path);
    const entry = state.files.get(normalized);
    if (!entry) {
      this.cache.delete(normalized);
      return;
    }

    try {
      // DEBUG: show content being parsed for failing tests (removed after fix)
      // console.log(`MetadataCache.updateCache(${normalized}) content:`, entry.content);
      const metadata = this.parseMetadata(entry.content);
      this.cache.set(normalized, metadata);
      this.trigger("changed", this.vault.getFileByPath(path));
    } catch {
      // Parsing error — keep cache absent
      this.cache.delete(normalized);
    }
  }

  private parseMetadata(content: string): CachedMetadata {
    const metadata: CachedMetadata = {};

    // Parse frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      try {
        metadata.frontmatter = parseYaml(frontmatterMatch[1] ?? "");
      } catch {
        metadata.frontmatter = {};
      }
    }

    // Parse headings
    const headings: Array<{ heading: string; level: number }> = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      const g1 = match[1] ?? "";
      const g2 = match[2] ?? "";
      headings.push({
        level: g1.length,
        heading: g2.trim(),
      });
    }
    if (headings.length > 0) {
      metadata.headings = headings;
    }

    // Parse wikilinks
    const links: Array<{
      link: string;
      original: string;
      displayText: string;
    }> = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    while ((match = linkRegex.exec(content)) !== null) {
      const linkText = match[1] ?? "";
      const originalText = match[0] ?? "";
      const display = match[2]?.trim() ?? linkText.trim();
      links.push({
        link: linkText.trim(),
        original: originalText,
        displayText: display,
      });
    }
    if (links.length > 0) {
      metadata.links = links;
    }

    // Parse tags
    const tags: Array<{
      tag: string;
      position: {
        start: { line: number; col: number; offset: number };
        end: { line: number; col: number; offset: number };
      };
    }> = [];
    const tagRegex = /#[\w-]+/g;
    while ((match = tagRegex.exec(content)) !== null) {
      const offset = match.index;
      const lines = content.slice(0, offset).split("\n");
      const line = lines.length - 1;
      const col = lines[lines.length - 1]?.length ?? 0;
      const tagText = match[0] ?? "";
      tags.push({
        tag: tagText,
        position: {
          start: { line, col, offset },
          end: {
            line,
            col: col + tagText.length,
            offset: offset + tagText.length,
          },
        },
      });
    }
    if (tags.length > 0) {
      metadata.tags = tags;
    }

    return metadata;
  }

  on(
    name: "changed" | "resolve" | "resolved",
    callback: (...args: unknown[]) => unknown,
    ctx?: unknown,
  ): EventRef {
    return super.on(name, callback, ctx);
  }

  trigger(name: "changed" | "resolve" | "resolved", ...args: unknown[]): void {
    super.trigger(name, ...args);
  }
}

// ===== Workspace =====

export class WorkspaceLeaf {
  view: { file: TFile | null } = { file: null };
  private viewState: { type: string; state: unknown } = {
    type: "empty",
    state: {},
  };

  getViewState(): { type: string; state: unknown } {
    return { ...this.viewState };
  }

  setViewState(viewState: { type: string; state?: unknown }): Promise<void> {
    this.viewState = { type: viewState.type, state: viewState.state ?? {} };
    return Promise.resolve();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  openFile(file: TFile, _openState?: { active?: boolean }): Promise<void> {
    this.view.file = file;
    return Promise.resolve();
  }

  getViewType(): string {
    return this.viewState.type;
  }
}

export class Workspace extends Events {
  activeLeaf: WorkspaceLeaf | null = null;
  leftSplit: { collapsed: boolean } = { collapsed: false };
  rightSplit: { collapsed: boolean } = { collapsed: false };

  getActiveFile(): TFile | null {
    return this.activeLeaf?.view.file ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getActiveViewOfType<T>(_type: new (...args: unknown[]) => T): T | null {
    return null;
  }

  getLeaf(newLeaf?: boolean): WorkspaceLeaf {
    if (!newLeaf && this.activeLeaf) return this.activeLeaf;
    const leaf = new WorkspaceLeaf();
    this.activeLeaf = leaf;
    return leaf;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getLeavesOfType(_type: string): WorkspaceLeaf[] {
    return [];
  }

  on(
    name: "active-leaf-change" | "file-open" | "layout-change" | "quit",
    callback: (...args: unknown[]) => unknown,
    ctx?: unknown,
  ): EventRef {
    return super.on(name, callback, ctx);
  }
}

// ===== Keymap & Scope =====

export class Keymap {
  pushScope(scope: Scope): void {
    state.keymapScopes.push(scope);
  }

  popScope(scope: Scope): void {
    const index = state.keymapScopes.indexOf(scope);
    if (index >= 0) {
      state.keymapScopes.splice(index, 1);
    }
  }

  getScopes(): Scope[] {
    return [...state.keymapScopes];
  }
}

export class Scope {
  keys: Array<{ modifiers: string; key: string | null; func: () => unknown }> =
    [];

  register(modifiers: string[], key: string | null, func: () => unknown): void {
    this.keys.push({ modifiers: modifiers.join("+"), key, func });
  }

  unregister(func: () => unknown): void {
    const index = this.keys.findIndex((k) => k.func === func);
    if (index >= 0) {
      this.keys.splice(index, 1);
    }
  }
}

// ===== App =====

export class App {
  vault: Vault;
  workspace: Workspace;
  fileManager: FileManager;
  metadataCache: MetadataCache;
  keymap: Keymap;
  scope: Scope;
  lastEvent: Event | null = null;

  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace();
    this.fileManager = new FileManager(this.vault);
    this.metadataCache = new MetadataCache(this.vault);
    this.keymap = new Keymap();
    this.scope = new Scope();
  }
}

// Minimal platform flags used by plugin-library
export const Platform = {
  isIosApp: false,
  isAndroidApp: false,
  isDesktopApp: true,
};

// ===== Plugin & PluginManifest =====

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export abstract class Plugin {
  app: App;
  manifest: PluginManifest;
  private commands: Array<{
    id: string;
    name: string;
    callback?: () => void;
    checkCallback?: (checking: boolean) => boolean;
  }> = [];
  private ribbonIcons: HTMLElement[] = [];
  private statusBarItems: HTMLElement[] = [];
  private settingTabs: PluginSettingTab[] = [];
  private registeredViews: Map<string, (leaf: WorkspaceLeaf) => unknown> =
    new Map();
  private registeredExtensions: Array<{
    extensions: string[];
    viewType: string;
  }> = [];
  private markdownProcessors: Array<(el: HTMLElement, ctx: unknown) => void> =
    [];
  private codeBlockProcessors: Map<
    string,
    (source: string, el: HTMLElement, ctx: unknown) => void
  > = new Map();
  private editorExtensions: unknown[] = [];
  private editorSuggests: unknown[] = [];
  private protocolHandlers: Map<string, (params: unknown) => void> = new Map();

  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: {
    id: string;
    name: string;
    callback?: () => void;
    checkCallback?: (checking: boolean) => boolean;
  }): void {
    this.commands.push(command);
  }

  addRibbonIcon(
    icon: string,
    title: string,
    callback: () => void,
  ): HTMLElement {
    const el = document.createElement("div");
    el.setAttribute("data-icon", icon);
    el.setAttribute("title", title);
    el.onclick = callback;
    this.ribbonIcons.push(el);
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const el = document.createElement("div");
    this.statusBarItems.push(el);
    return el;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  registerView(
    type: string,
    viewCreator: (leaf: WorkspaceLeaf) => unknown,
  ): void {
    this.registeredViews.set(type, viewCreator);
  }

  registerExtensions(extensions: string[], viewType: string): void {
    this.registeredExtensions.push({ extensions, viewType });
  }

  registerMarkdownPostProcessor(
    processor: (el: HTMLElement, ctx: unknown) => void,
  ): void {
    this.markdownProcessors.push(processor);
  }

  registerMarkdownCodeBlockProcessor(
    language: string,
    processor: (source: string, el: HTMLElement, ctx: unknown) => void,
  ): void {
    this.codeBlockProcessors.set(language, processor);
  }

  registerEditorExtension(extension: unknown): void {
    this.editorExtensions.push(extension);
  }

  registerEditorSuggest(suggest: unknown): void {
    this.editorSuggests.push(suggest);
  }

  registerObsidianProtocolHandler(
    action: string,
    handler: (params: unknown) => void,
  ): void {
    this.protocolHandlers.set(action, handler);
  }

  loadData(): Promise<unknown> {
    return Promise.resolve(state.pluginData.get(this) ?? null);
  }

  saveData(data: unknown): Promise<void> {
    state.pluginData.set(this, data);
    return Promise.resolve();
  }

  getCommands(): typeof this.commands {
    return [...this.commands];
  }

  getRibbonIcons(): HTMLElement[] {
    return [...this.ribbonIcons];
  }

  getStatusBarItems(): HTMLElement[] {
    return [...this.statusBarItems];
  }

  getSettingTabs(): PluginSettingTab[] {
    return [...this.settingTabs];
  }

  getRegisteredViews(): Map<string, (leaf: WorkspaceLeaf) => unknown> {
    return new Map(this.registeredViews);
  }

  abstract onload(): void | Promise<void>;
  onunload(): void {}
}

export abstract class PluginSettingTab {
  app: App;
  plugin: Plugin;
  // containerEl exists on the real API; the mock must provide it for UI tests
  containerEl: HTMLElement;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    // provide a real DOM element so tests can query/append children
    this.containerEl = document.createElement("div");
  }
  abstract display(): void;
  hide(): void {}
}

// ===== Components =====

export class Component {
  private loaded = false;
  private children: Component[] = [];
  private callbacks: Array<() => void> = [];
  private eventRefs: EventRef[] = [];
  private intervals: number[] = [];

  load(): void {
    if (!this.loaded) {
      this.loaded = true;
      this.onload();
    }
  }

  onload(): void {}

  unload(): void {
    if (this.loaded) {
      this.onunload();
      this.callbacks.forEach((cb) => cb());
      this.callbacks = [];
      this.eventRefs = [];
      this.intervals.forEach((id) => clearInterval(id));
      this.intervals = [];
      this.children.forEach((child) => child.unload());
      this.loaded = false;
    }
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    this.children.push(component);
    if (this.loaded) {
      component.load();
    }
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const index = this.children.indexOf(component);
    if (index >= 0) {
      this.children.splice(index, 1);
      component.unload();
    }
    return component;
  }

  register(cb: () => void): void {
    this.callbacks.push(cb);
  }

  registerEvent(eventRef: EventRef): void {
    this.eventRefs.push(eventRef);
  }

  registerDomEvent<K extends keyof WindowEventMap>(
    el: Window,
    type: K,
    callback: (this: HTMLElement, ev: WindowEventMap[K]) => unknown,
  ): void;
  registerDomEvent<K extends keyof DocumentEventMap>(
    el: Document,
    type: K,
    callback: (this: HTMLElement, ev: DocumentEventMap[K]) => unknown,
  ): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    callback: (this: HTMLElement, ev: HTMLElementEventMap[K]) => unknown,
  ): void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  registerDomEvent(_el: unknown, _type: string, _callback: unknown): void {
    // Store for cleanup
  }

  registerInterval(id: number): number {
    this.intervals.push(id);
    return id;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

export class ItemView extends Component {
  leaf: WorkspaceLeaf;
  contentEl: HTMLElement;
  app: App;
  navigation = false;

  constructor(leaf?: WorkspaceLeaf) {
    super();
    this.leaf = leaf ?? new WorkspaceLeaf();
    this.contentEl = document.createElement("div");
    this.app = getApp();
  }

  getViewType(): string {
    return this.leaf.getViewType();
  }

  getDisplayText(): string {
    return "";
  }

  getIcon(): string {
    return "";
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setState(_state: unknown, _result?: unknown): Promise<void> {
    return Promise.resolve();
  }

  getState(): unknown {
    return {};
  }
}

export class ButtonComponent {
  private value = "";
  private clickHandler: (() => void) | null = null;
  private tooltip = "";
  private cssClass = "";
  private disabled = false;
  private cta = false;
  private warning = false;

  setButtonText(text: string): this {
    this.value = text;
    return this;
  }

  getButtonText(): string {
    return this.value;
  }

  // Add `setIcon` as a harmless alias to improve API fidelity for tests that
  // call `setIcon(...)` (some package tests expect this chainable method).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setIcon(_icon?: string): this {
    return this;
  }

  setTooltip(tooltip: string): this {
    this.tooltip = tooltip;
    return this;
  }

  getTooltip(): string {
    return this.tooltip;
  }

  setClass(cls: string): this {
    this.cssClass = cls;
    return this;
  }

  getClass(): string {
    return this.cssClass;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  setCta(): this {
    this.cta = true;
    return this;
  }

  // provide `getCta()` (tests use that name) as an alias to `isCta()`
  getCta(): boolean {
    return this.cta;
  }

  isCta(): boolean {
    return this.cta;
  }

  setWarning(): this {
    this.warning = true;
    return this;
  }

  isWarning(): boolean {
    return this.warning;
  }

  onClick(callback: () => void): this {
    this.clickHandler = callback;
    return this;
  }

  // provide `click()` as an alias used by some tests
  click(): void {
    this.trigger();
  }

  trigger(): void {
    if (!this.disabled) {
      this.clickHandler?.();
    }
  }
}

// --------- Add a lightweight `Setting` helper used by plugin tests ---------
export class Setting {
  constructor(public capturedButtons?: ButtonComponent[]) {}

  public setName(): this {
    return this;
  }
  public setDesc(): this {
    return this;
  }
  public setTooltip(): this {
    return this;
  }
  public setDisabled(): this {
    return this;
  }

  public addButton(cb: (b: ButtonComponent) => void): this {
    const b = new ButtonComponent();
    if (this.capturedButtons) this.capturedButtons.push(b);
    cb(b);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public addToggle(_v: unknown): this {
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public addDropdown(_v: unknown): this {
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public addText(_v: unknown): this {
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public addTextArea(_v: unknown): this {
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public addExtraButton(_v: unknown): this {
    return this;
  }
}

export class ToggleComponent {
  private value = false;
  private changeHandler: ((value: boolean) => void) | null = null;
  private tooltip = "";
  private disabled = false;

  getValue(): boolean {
    return this.value;
  }

  setValue(value: boolean): this {
    if (!this.disabled) {
      this.value = value;
      this.changeHandler?.(value);
    }
    return this;
  }

  setTooltip(tooltip: string): this {
    this.tooltip = tooltip;
    return this;
  }

  getTooltip(): string {
    return this.tooltip;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  onChange(callback: (value: boolean) => void): this {
    this.changeHandler = callback;
    return this;
  }
}

export class TextComponent {
  private value = "";
  private changeHandler: ((value: string) => void) | null = null;
  private placeholder = "";
  private disabled = false;

  getValue(): string {
    return this.value;
  }

  setValue(value: string): this {
    if (!this.disabled) {
      this.value = value;
      this.changeHandler?.(value);
    }
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }

  getPlaceholder(): string {
    return this.placeholder;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  onChange(callback: (value: string) => void): this {
    this.changeHandler = callback;
    return this;
  }
}

export class ColorComponent {
  private value = "#000000";
  private changeHandler: ((value: string) => void) | null = null;

  getValue(): string {
    return this.value;
  }

  setValue(value: string): this {
    this.value = value;
    this.changeHandler?.(value);
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.changeHandler = callback;
    return this;
  }
}

export class SliderComponent {
  private value = 0;
  private changeHandler: ((value: number) => void) | null = null;

  getValue(): number {
    return this.value;
  }

  setValue(value: number): this {
    this.value = value;
    this.changeHandler?.(value);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setLimits(_min: number, _max: number, _step: number): this {
    return this;
  }

  setDynamicTooltip(): this {
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setDisabled(_disabled: boolean): this {
    return this;
  }

  onChange(callback: (value: number) => void): this {
    this.changeHandler = callback;
    return this;
  }
}

export class DropdownComponent {
  private value = "";
  private options: Record<string, string> = {};
  private changeHandler: ((value: string) => void) | null = null;

  getValue(): string {
    return this.value;
  }

  setValue(value: string): this {
    this.value = value;
    this.changeHandler?.(value);
    return this;
  }

  addOption(value: string, display: string): this {
    this.options[value] = display;
    return this;
  }

  addOptions(options: Record<string, string>): this {
    this.options = { ...this.options, ...options };
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setDisabled(_disabled: boolean): this {
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.changeHandler = callback;
    return this;
  }
}

// ===== Modal & Notice =====

export class Modal extends Component {
  app: App;
  titleEl: HTMLElement = document.createElement("div");
  contentEl: HTMLElement = document.createElement("div");
  modalEl: HTMLElement = document.createElement("div");
  private opened = false;

  constructor(app: App) {
    super();
    this.app = app;
  }

  open(): void {
    this.opened = true;
    this.onOpen();
  }

  close(): void {
    this.opened = false;
    this.onClose();
  }

  isOpen(): boolean {
    return this.opened;
  }

  onOpen(): void {}
  onClose(): void {}
}

export class Notice {
  private message: string | DocumentFragment;
  private duration: number;
  private hidden = false;
  private hideTimeout: NodeJS.Timeout | null = null;

  constructor(message: string | DocumentFragment, duration = 5000) {
    this.message = message;
    this.duration = duration;
    if (duration > 0) {
      this.hideTimeout = setTimeout(() => this.hide(), duration);
    }
  }

  setMessage(message: string | DocumentFragment): this {
    this.message = message;
    return this;
  }

  getMessage(): string | DocumentFragment {
    return this.message;
  }

  getDuration(): number {
    return this.duration;
  }

  hide(): void {
    if (!this.hidden) {
      this.hidden = true;
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }
    }
  }

  isHidden(): boolean {
    return this.hidden;
  }
}

// ===== Utility Functions =====

export function normalizePath(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\//, "")
      .replace(/\/$/, "") || "/"
  );
}

export function stripHeading(heading: string): string {
  return heading.replace(/^#+\s*/, "");
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
  immediate = false,
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  return function (this: unknown, ...args: Parameters<T>): void {
    const later = (): void => {
      timeout = null;
      if (!immediate) func.apply(this, args);
    };
    const callNow = immediate && !timeout;
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func.apply(this, args);
  };
}

export interface PreparedQuery {
  query: string;
  tokens: string[];
}

export function prepareQuery(query: string): PreparedQuery {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return { query: query.toLowerCase(), tokens };
}

export function prepareSimpleSearch(query: string): PreparedQuery {
  return prepareQuery(query);
}

export function prepareFuzzySearch(query: string): PreparedQuery {
  return prepareQuery(query);
}

// ===== Network Functions =====

export async function request(
  param: RequestUrlParam | string,
): Promise<string> {
  const response = await requestUrl(
    typeof param === "string" ? { url: param } : param,
  );
  return response.text;
}

export function requestUrl(param: RequestUrlParam): RequestUrlResponsePromise {
  state.requestCalls.push({ url: param.url, param });

  if (state.requestHandler) {
    const promise = state.requestHandler(param) as RequestUrlResponsePromise;
    promise.arrayBuffer = async () => promise.then((r) => r.arrayBuffer);
    promise.json = async () => promise.then((r) => r.json);
    promise.text = async () => promise.then((r) => r.text);
    return promise;
  }

  for (const stub of state.requestStubs) {
    const matches =
      typeof stub.matcher === "string"
        ? param.url === stub.matcher
        : stub.matcher.test(param.url);
    if (matches) {
      const response =
        typeof stub.response === "function" ? stub.response() : stub.response;
      const promise = Promise.resolve(response) as RequestUrlResponsePromise;
      promise.arrayBuffer = async () => response.arrayBuffer;
      promise.json = async () => response.json;
      promise.text = async () => response.text;
      return promise;
    }
  }

  const promise = fetch(param.url, {
    method: param.method,
    body: param.body,
    headers: param.headers,
  }).then(async (res) => {
    const text = await res.text();
    const arrayBuffer = new TextEncoder().encode(text).buffer;
    return {
      status: res.status,
      headers: Object.fromEntries(
        (() => {
          const entries: [string, string][] = [];
          res.headers.forEach((value, key) => {
            entries.push([key, value]);
          });
          return entries;
        })(),
      ),
      arrayBuffer,
      json: JSON.parse(text),
      text,
    };
  }) as RequestUrlResponsePromise;

  promise.arrayBuffer = async () => promise.then((r) => r.arrayBuffer);
  promise.json = async () => promise.then((r) => r.json);
  promise.text = async () => promise.then((r) => r.text);

  return promise;
}

// ===== Rendering Helpers (No-ops) =====

export const MarkdownRenderer = {
  renderMarkdown: async (
    markdown: string,
    el: HTMLElement,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sourcePath: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _component: Component,
  ): Promise<void> => {
    el.textContent = markdown;
  },
  // Some environments/tests expect the newer `render(app, ...)` API —
  // provide a thin shim so both signatures work in tests.
  render: async (
    _app: App,
    markdown: string,
    el: HTMLElement,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sourcePath: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _component: Component,
  ): Promise<void> => {
    el.textContent = markdown;
  },
};

export function renderMath(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _el: HTMLElement,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _text: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _displayMode: boolean,
): Promise<void> {
  return Promise.resolve();
}

export function loadMathJax(): Promise<void> {
  return Promise.resolve();
}

export function loadMermaid(): Promise<void> {
  return Promise.resolve();
}

export function loadPdfJs(): Promise<void> {
  return Promise.resolve();
}

export function loadPrism(): Promise<void> {
  return Promise.resolve();
}

// ===== YAML Helpers =====

export { parseYaml, stringifyYaml };

export function parseFrontMatterEntry(entry: string): Record<string, unknown> {
  try {
    return parseYaml(entry);
  } catch {
    return {};
  }
}

export function parseFrontMatterTags(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] {
  if (!frontmatter) return [];
  const tags = frontmatter.tags;
  if (typeof tags === "string") return [tags];
  if (Array.isArray(tags)) return tags.filter((t) => typeof t === "string");
  return [];
}

export function parseFrontMatterAliases(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] {
  if (!frontmatter) return [];
  const aliases = frontmatter.aliases ?? frontmatter.alias;
  if (typeof aliases === "string") return [aliases];
  if (Array.isArray(aliases))
    return aliases.filter((a) => typeof a === "string");
  return [];
}

// ===== Icons =====

export function addIcon(iconId: string, svgContent: string): void {
  state.icons.set(iconId, svgContent);
}

export function getIcon(iconId: string): string | null {
  return state.icons.get(iconId) ?? null;
}

export function setIcon(el: HTMLElement, iconId: string): void {
  const svg = state.icons.get(iconId);
  if (svg) el.innerHTML = svg;
}

export function removeIcon(iconId: string): void {
  state.icons.delete(iconId);
}

// ===== Test Helpers =====

const appInstance = new App();

export function reset(): void {
  state.files.clear();
  state.editors = [];
  state.icons.clear();
  state.requestHandler = null;
  state.requestStubs = [];
  state.requestCalls = [];
  state.vaultConfig.clear();
  state.keymapScopes = [];
  state.pluginData.clear();

  // Reset cached app-level state so tests start from a clean slate.
  // Recreate the metadata cache (it holds internal cached parse results).
  try {
    appInstance.metadataCache = new MetadataCache(appInstance.vault);
  } catch {
    // ignore in environments where appInstance isn't initialized yet
  }
}

export function setVaultFiles(
  files: Record<
    string,
    string | { content: string; stat?: Partial<FileStats> }
  >,
): void {
  state.files.clear();
  const now = Date.now();
  for (const [path, data] of Object.entries(files)) {
    const normalized = normalizePath(path);
    const content = typeof data === "string" ? data : data.content;
    const stat =
      typeof data === "string"
        ? { ctime: now, mtime: now, size: content.length }
        : { ctime: now, mtime: now, size: content.length, ...data.stat };
    state.files.set(normalized, { content, stat });
  }
}

export function setRequestHandler(
  handler: (param: RequestUrlParam) => Promise<RequestUrlResponse>,
): void {
  state.requestHandler = handler;
}

export function setRequestResponse(
  matcher: string | RegExp,
  response: RequestUrlResponse | (() => RequestUrlResponse),
): void {
  state.requestStubs.push({ matcher, response });
}

export function getApp(): App {
  return appInstance;
}

export function getVault(): Vault {
  return appInstance.vault;
}

export function makeEditor(content = ""): Editor {
  const editor = new Editor(content);
  state.editors.push(editor);
  return editor;
}

export function spyRequests(): {
  calls: Array<{ url: string; param: RequestUrlParam }>;
} {
  return { calls: state.requestCalls };
}
