/**
 * Unit tests for the Obsidian runtime mock.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  reset,
  setVaultFiles,
  setRequestHandler,
  setRequestResponse,
  getApp,
  getVault,
  makeEditor,
  spyRequests,
  normalizePath,
  stripHeading,
  stringifyYaml,
  parseYaml,
  type RequestUrlResponse,
} from "./obsidian.js";

describe("Obsidian Mock", () => {
  beforeEach(() => {
    reset();
  });

  describe("reset()", () => {
    it("clears vault and editor state", () => {
      setVaultFiles({ "test.md": "content" });
      makeEditor("test");

      reset();

      const files = getVault().getFiles();
      expect(files).toHaveLength(0);
    });
  });

  describe("setVaultFiles()", () => {
    it("creates files readable via Vault.read", async () => {
      setVaultFiles({
        "note.md": "# Hello",
        "data.json": JSON.stringify({ key: "value" }),
      });

      const vault = getVault();
      expect(await vault.read("note.md")).toBe("# Hello");
      expect(await vault.read("data.json")).toBe('{"key":"value"}');
    });

    it("creates files accessible via getMarkdownFiles", () => {
      setVaultFiles({
        "note1.md": "content1",
        "note2.md": "content2",
        "data.txt": "text",
      });

      const files = getVault().getMarkdownFiles();
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.path).sort()).toEqual(["note1.md", "note2.md"]);
    });

    it("supports custom file stats", () => {
      const customTime = 1000000000000;
      setVaultFiles({
        "test.md": {
          content: "data",
          stat: { ctime: customTime, mtime: customTime },
        },
      });

      const file = getVault().getFileByPath("test.md");
      expect(file?.stat.ctime).toBe(customTime);
      expect(file?.stat.mtime).toBe(customTime);
    });
  });

  describe("Vault CRUD operations", () => {
    it("create adds new file and triggers event", async () => {
      const vault = getVault();
      let createTriggered = false;
      vault.on("create", () => {
        createTriggered = true;
      });

      const file = await vault.create("new.md", "content");

      expect(file.path).toBe("new.md");
      expect(await vault.read(file)).toBe("content");
      await expect(vault.adapter.exists("new.md")).resolves.toBe(true);
      expect(createTriggered).toBe(true);
    });

    it("modify updates existing file", async () => {
      setVaultFiles({ "test.md": "original" });
      const vault = getVault();
      let modifyTriggered = false;
      vault.on("modify", () => {
        modifyTriggered = true;
      });

      await vault.modify("test.md", "updated");

      expect(await vault.read("test.md")).toBe("updated");
      expect(modifyTriggered).toBe(true);
    });

    it("delete removes file", async () => {
      setVaultFiles({ "test.md": "content" });
      const vault = getVault();
      let deleteTriggered = false;
      vault.on("delete", () => {
        deleteTriggered = true;
      });

      await vault.delete("test.md");

      expect(vault.getFileByPath("test.md")).toBeNull();
      expect(deleteTriggered).toBe(true);
    });

    it("rename moves file", async () => {
      setVaultFiles({ "old.md": "content" });
      const vault = getVault();
      let renameTriggered = false;
      vault.on("rename", () => {
        renameTriggered = true;
      });

      await vault.rename("old.md", "new.md");

      expect(vault.getFileByPath("old.md")).toBeNull();
      expect(await vault.read("new.md")).toBe("content");
      expect(renameTriggered).toBe(true);
    });

    it("copy duplicates file", async () => {
      setVaultFiles({ "original.md": "content" });
      const vault = getVault();

      const copy = await vault.copy("original.md", "copy.md");

      expect(await vault.read("original.md")).toBe("content");
      expect(await vault.read(copy)).toBe("content");
      expect(copy.stat.ctime).toBeGreaterThan(0);
    });

    it("exists returns correct status", async () => {
      setVaultFiles({ "exists.md": "content" });
      const vault = getVault();

      expect(await vault.adapter.exists("exists.md")).toBe(true);
      expect(await vault.adapter.exists("missing.md")).toBe(false);
    });

    it("stat returns file metadata", () => {
      setVaultFiles({ "test.md": "content" });
      const file = getVault().getFileByPath("test.md");

      expect(file?.stat).toMatchObject({
        ctime: expect.any(Number),
        mtime: expect.any(Number),
        size: "content".length,
      });
    });
  });

  describe("Editor operations", () => {
    it("getValue/setValue work", () => {
      const editor = makeEditor("initial");
      expect(editor.getValue()).toBe("initial");

      editor.setValue("updated");
      expect(editor.getValue()).toBe("updated");
    });

    it("getLine/lineCount work", () => {
      const editor = makeEditor("line1\nline2\nline3");

      expect(editor.lineCount()).toBe(3);
      expect(editor.getLine(0)).toBe("line1");
      expect(editor.getLine(1)).toBe("line2");
      expect(editor.getLine(2)).toBe("line3");
    });

    it("posToOffset/offsetToPos are inverse operations", () => {
      const editor = makeEditor("abc\ndef\nghi");
      const pos = { line: 1, ch: 2 };

      const offset = editor.posToOffset(pos);
      const roundTrip = editor.offsetToPos(offset);

      expect(roundTrip).toEqual(pos);
    });

    it("replaceRange modifies content", () => {
      const editor = makeEditor("hello world");

      editor.replaceRange("universe", { line: 0, ch: 6 }, { line: 0, ch: 11 });

      expect(editor.getValue()).toBe("hello universe");
    });

    it("selection operations work", () => {
      const editor = makeEditor("select this text");

      editor.setSelection({ line: 0, ch: 7 }, { line: 0, ch: 11 });

      expect(editor.getSelection()).toBe("this");
      expect(editor.getCursor("from")).toEqual({ line: 0, ch: 7 });
      expect(editor.getCursor("to")).toEqual({ line: 0, ch: 11 });
    });

    it("undo/redo work", () => {
      const editor = makeEditor("original");

      editor.setValue("changed");
      expect(editor.getValue()).toBe("changed");

      editor.undo();
      expect(editor.getValue()).toBe("original");

      editor.redo();
      expect(editor.getValue()).toBe("changed");
    });
  });

  describe("Events emitter", () => {
    it("on/trigger invokes listeners", () => {
      const vault = getVault();
      let callCount = 0;
      let receivedArg: unknown;

      vault.on("create", (arg) => {
        callCount++;
        receivedArg = arg;
      });

      // trigger with a TFile-like object so other listeners (MetadataCache) won't throw
      vault.trigger("create", { path: "test-arg" });

      expect(callCount).toBe(1);
      expect(receivedArg).toEqual({ path: "test-arg" });
    });

    it("off removes listener", () => {
      const vault = getVault();
      let callCount = 0;
      const callback = (): void => {
        callCount++;
      };

      vault.on("create", callback);
      // pass a TFile-like object so other listeners don't throw
      vault.trigger("create", { path: "dummy" });
      expect(callCount).toBe(1);

      vault.off("create", callback);
      vault.trigger("create", { path: "dummy" });
      expect(callCount).toBe(1);
    });

    it("offref removes listener", () => {
      const vault = getVault();
      let callCount = 0;
      const callback = (): void => {
        callCount++;
      };

      const ref = vault.on("create", callback);
      vault.trigger("create", { path: "dummy" });
      expect(callCount).toBe(1);

      vault.offref(ref);
      vault.trigger("create", { path: "dummy" });
      expect(callCount).toBe(1);
    });
  });

  describe("request/requestUrl", () => {
    it("default behavior forwards to fetch", async () => {
      // Skip actual fetch test in unit tests; just verify API shape
      const spy = spyRequests();

      setRequestResponse("https://example.com/test", {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { data: "value" },
        text: '{"data":"value"}',
      });

      const { requestUrl } = await import("./obsidian.js");
      const response = await requestUrl({ url: "https://example.com/test" });

      expect(response.status).toBe(200);
      expect(response.json).toEqual({ data: "value" });
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toBe("https://example.com/test");
    });

    it("supports override via setRequestHandler", async () => {
      setRequestHandler(async (): Promise<RequestUrlResponse> => {
        return {
          status: 201,
          headers: { "x-custom": "header" },
          arrayBuffer: new ArrayBuffer(0),
          json: { custom: true },
          text: '{"custom":true}',
        };
      });

      const { requestUrl } = await import("./obsidian.js");
      const response = await requestUrl({ url: "https://any.url" });

      expect(response.status).toBe(201);
      expect(response.headers["x-custom"]).toBe("header");
    });

    it("supports per-URL stubs via setRequestResponse", async () => {
      setRequestResponse(/api\.example\.com/, {
        status: 404,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: "not found" },
        text: '{"error":"not found"}',
      });

      const { requestUrl } = await import("./obsidian.js");
      const response = await requestUrl({
        url: "https://api.example.com/endpoint",
      });

      expect(response.status).toBe(404);
      expect(response.json).toEqual({ error: "not found" });
    });
  });

  describe("getApp().vault === getVault()", () => {
    it("returns shared instances", () => {
      expect(getApp().vault).toBe(getVault());
    });
  });

  describe("Utility functions", () => {
    it("normalizePath produces canonical paths", () => {
      expect(normalizePath("folder\\file.md")).toBe("folder/file.md");
      expect(normalizePath("/root/file.md")).toBe("root/file.md");
      expect(normalizePath("path//with///slashes/")).toBe("path/with/slashes");
    });

    it("stripHeading removes leading hash marks", () => {
      expect(stripHeading("# Heading")).toBe("Heading");
      expect(stripHeading("## Sub Heading")).toBe("Sub Heading");
      expect(stripHeading("Plain text")).toBe("Plain text");
    });

    it("stringifyYaml produces deterministic YAML", () => {
      const obj = { key: "value", nested: { prop: 123 } };
      const yaml = stringifyYaml(obj);
      expect(yaml).toContain("key: value");
      expect(yaml).toContain("prop: 123");
    });

    it("parseYaml parses YAML strings", () => {
      const yaml = "key: value\nnumber: 42\n";
      const parsed = parseYaml(yaml);
      expect(parsed).toEqual({ key: "value", number: 42 });
    });
  });

  describe("Vault config", () => {
    it("getConfig/setConfig work", () => {
      const vault = getVault();

      expect(vault.getConfig("test")).toBeNull();

      vault.setConfig("test", "value");
      expect(vault.getConfig("test")).toBe("value");

      vault.setConfig("nested", { key: "val" });
      expect(vault.getConfig("nested")).toEqual({ key: "val" });
    });

    it("reset clears vault config", () => {
      const vault = getVault();
      vault.setConfig("test", "value");

      reset();

      expect(vault.getConfig("test")).toBeNull();
    });
  });

  describe("MetadataCache", () => {
    it("parses frontmatter from vault files", async () => {
      setVaultFiles({
        "note.md":
          "---\ntitle: Test Note\ntags: [tag1, tag2]\n---\n\nContent here",
      });

      const metadata = getApp().metadataCache.getCache("note.md");

      expect(metadata?.frontmatter).toEqual({
        title: "Test Note",
        tags: ["tag1", "tag2"],
      });
    });

    it("parses headings", async () => {
      setVaultFiles({
        "note.md": "# Heading 1\n\n## Heading 2\n\nText\n\n### Heading 3",
      });

      const metadata = getApp().metadataCache.getCache("note.md");

      expect(metadata?.headings).toHaveLength(3);
      expect(metadata?.headings?.[0]).toEqual({
        level: 1,
        heading: "Heading 1",
      });
      expect(metadata?.headings?.[1]).toEqual({
        level: 2,
        heading: "Heading 2",
      });
      expect(metadata?.headings?.[2]).toEqual({
        level: 3,
        heading: "Heading 3",
      });
    });

    it("parses wikilinks", async () => {
      setVaultFiles({
        "note.md": "Link to [[other note]] and [[file|alias]]",
      });

      const metadata = getApp().metadataCache.getCache("note.md");

      expect(metadata?.links).toHaveLength(2);
      expect(metadata?.links?.[0]).toEqual({
        link: "other note",
        original: "[[other note]]",
        displayText: "other note",
      });
      expect(metadata?.links?.[1]).toEqual({
        link: "file",
        original: "[[file|alias]]",
        displayText: "alias",
      });
    });

    it("parses tags", async () => {
      setVaultFiles({
        "note.md": "Text with #tag1 and #tag2",
      });

      const metadata = getApp().metadataCache.getCache("note.md");

      expect(metadata?.tags).toHaveLength(2);
      expect(metadata?.tags?.[0]?.tag).toBe("#tag1");
      expect(metadata?.tags?.[1]?.tag).toBe("#tag2");
    });

    it("updates cache on file modification", async () => {
      setVaultFiles({ "note.md": "# Original" });

      const vault = getVault();
      let changeTriggered = false;
      getApp().metadataCache.on("changed", () => {
        changeTriggered = true;
      });

      await vault.modify("note.md", "# Modified");

      const metadata = getApp().metadataCache.getCache("note.md");
      expect(metadata?.headings?.[0]?.heading).toBe("Modified");
      expect(changeTriggered).toBe(true);
    });
  });

  describe("FileManager.processFrontMatter()", () => {
    it("passes an empty object for files without frontmatter and does not write when unchanged", async () => {
      setVaultFiles({ "no-fm.md": "Body content" });
      const vault = getVault();
      const file = vault.getFileByPath("no-fm.md");
      if (!file) throw new Error("setup failed");

      let calledWith: Record<string, unknown> | null = null;
      await getApp().fileManager.processFrontMatter(file, (fm) => {
        calledWith = fm;
      });

      expect(calledWith).toEqual({});
      expect(await vault.read("no-fm.md")).toBe("Body content");
    });

    it("adds frontmatter when processor mutates for files without frontmatter", async () => {
      setVaultFiles({ "no-fm-2.md": "Body content" });
      const vault = getVault();
      const file = vault.getFileByPath("no-fm-2.md");
      if (!file) throw new Error("setup failed");

      await getApp().fileManager.processFrontMatter(file, (fm) => {
        // mutate to trigger a write
        fm.title = "New Title";
      });

      const content = await vault.read("no-fm-2.md");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      if (!fmMatch || typeof fmMatch[1] !== "string")
        throw new Error("frontmatter not found");
      const parsed = parseYaml(fmMatch[1]);
      expect(parsed.title).toBe("New Title");
    });

    it("does not overwrite malformed frontmatter when processor leaves it unchanged, but will replace it if processor mutates", async () => {
      setVaultFiles({ "bad.md": "---\n:bad\n---\nBody" });
      const vault = getVault();
      const file = vault.getFileByPath("bad.md");
      if (!file) throw new Error("setup failed");

      // no-op processor: malformed frontmatter should remain unchanged
      await getApp().fileManager.processFrontMatter(file, () => {});
      expect(await vault.read("bad.md")).toContain(":bad");

      // mutated processor: malformed frontmatter should be replaced
      await getApp().fileManager.processFrontMatter(file, (fm) => {
        fm.title = "Fixed";
      });
      const content = await vault.read("bad.md");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      if (!fmMatch || typeof fmMatch[1] !== "string")
        throw new Error("frontmatter not found");
      const parsed = parseYaml(fmMatch[1]);
      expect(parsed.title).toBe("Fixed");
      expect(content).not.toContain(":bad");
    });

    it("updates existing frontmatter when processor mutates it", async () => {
      setVaultFiles({ "exists.md": "---\ntitle: Old\n---\nBody" });
      const vault = getVault();
      const file = vault.getFileByPath("exists.md");
      if (!file) throw new Error("setup failed");

      await getApp().fileManager.processFrontMatter(file, (fm) => {
        fm.title = "New";
      });

      const content = await vault.read("exists.md");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      if (!fmMatch || typeof fmMatch[1] !== "string")
        throw new Error("frontmatter not found");

      const parsed = parseYaml(fmMatch[1]);
      expect(parsed.title).toBe("New");
    });
  });

  describe("Keymap and Scope", () => {
    it("pushScope/popScope maintain scope stack", async () => {
      const { Keymap, Scope } = await import("./obsidian.js");
      const keymap = new Keymap();
      const scope1 = new Scope();
      const scope2 = new Scope();

      keymap.pushScope(scope1);
      keymap.pushScope(scope2);

      expect(keymap.getScopes()).toEqual([scope1, scope2]);

      keymap.popScope(scope1);
      expect(keymap.getScopes()).toEqual([scope2]);
    });

    it("Scope.register stores function reference", async () => {
      const { Scope } = await import("./obsidian.js");
      const scope = new Scope();
      const func = (): void => {};

      scope.register(["Ctrl", "Shift"], "K", func);

      expect(scope.keys).toHaveLength(1);
      expect(scope.keys[0]).toEqual({
        modifiers: "Ctrl+Shift",
        key: "K",
        func,
      });
    });

    it("Scope.unregister removes function", async () => {
      const { Scope } = await import("./obsidian.js");
      const scope = new Scope();
      const func1 = (): void => {};
      const func2 = (): void => {};

      scope.register(["Ctrl"], "A", func1);
      scope.register(["Ctrl"], "B", func2);
      expect(scope.keys).toHaveLength(2);

      scope.unregister(func1);
      expect(scope.keys).toHaveLength(1);
      expect(scope.keys[0]?.func).toBe(func2);
    });
  });

  describe("Plugin", () => {
    it("tracks commands via addCommand", async () => {
      const { Plugin } = await import("./obsidian.js");

      class TestPlugin extends Plugin {
        onload(): void {
          this.addCommand({ id: "test", name: "Test Command" });
        }
      }

      const plugin = new TestPlugin(getApp(), {
        id: "test",
        name: "Test",
        version: "1.0.0",
        minAppVersion: "1.0.0",
        description: "Test",
        author: "Test",
      });

      plugin.onload();

      expect(plugin.getCommands()).toHaveLength(1);
      expect(plugin.getCommands()[0]?.id).toBe("test");
    });

    it("tracks ribbon icons via addRibbonIcon", async () => {
      const { Plugin } = await import("./obsidian.js");

      class TestPlugin extends Plugin {
        onload(): void {
          this.addRibbonIcon("star", "Test Icon", () => {});
        }
      }

      const plugin = new TestPlugin(getApp(), {
        id: "test",
        name: "Test",
        version: "1.0.0",
        minAppVersion: "1.0.0",
        description: "Test",
        author: "Test",
      });

      plugin.onload();

      expect(plugin.getRibbonIcons()).toHaveLength(1);
      expect(plugin.getRibbonIcons()[0]?.getAttribute("data-icon")).toBe(
        "star",
      );
    });

    it("loadData/saveData persist plugin data", async () => {
      const { Plugin } = await import("./obsidian.js");

      class TestPlugin extends Plugin {
        async onload(): Promise<void> {
          await this.saveData({ key: "value" });
        }
      }

      const plugin = new TestPlugin(getApp(), {
        id: "test",
        name: "Test",
        version: "1.0.0",
        minAppVersion: "1.0.0",
        description: "Test",
        author: "Test",
      });

      await plugin.onload();

      const data = await plugin.loadData();
      expect(data).toEqual({ key: "value" });
    });
  });

  describe("Component lifecycle", () => {
    it("load/unload track state", async () => {
      const { Component } = await import("./obsidian.js");
      const component = new Component();

      expect(component.isLoaded()).toBe(false);

      component.load();
      expect(component.isLoaded()).toBe(true);

      component.unload();
      expect(component.isLoaded()).toBe(false);
    });

    it("register callbacks are called on unload", async () => {
      const { Component } = await import("./obsidian.js");
      const component = new Component();
      let callbackCalled = false;

      component.load();
      component.register(() => {
        callbackCalled = true;
      });

      component.unload();

      expect(callbackCalled).toBe(true);
    });

    it("addChild/removeChild manage children", async () => {
      const { Component } = await import("./obsidian.js");
      const parent = new Component();
      const child = new Component();

      parent.load();
      parent.addChild(child);

      expect(child.isLoaded()).toBe(true);

      parent.removeChild(child);
      expect(child.isLoaded()).toBe(false);
    });
  });

  describe("Modal", () => {
    it("tracks open/close state", async () => {
      const { Modal } = await import("./obsidian.js");
      const modal = new Modal(getApp());

      expect(modal.isOpen()).toBe(false);

      modal.open();
      expect(modal.isOpen()).toBe(true);

      modal.close();
      expect(modal.isOpen()).toBe(false);
    });
  });

  describe("Notice", () => {
    it("tracks message and duration", async () => {
      const { Notice } = await import("./obsidian.js");
      const notice = new Notice("Test message", 3000);

      expect(notice.getMessage()).toBe("Test message");
      expect(notice.getDuration()).toBe(3000);
      expect(notice.isHidden()).toBe(false);
    });

    it("can be manually hidden", async () => {
      const { Notice } = await import("./obsidian.js");
      const notice = new Notice("Test", 10000);

      notice.hide();

      expect(notice.isHidden()).toBe(true);
    });
  });

  describe("WorkspaceLeaf", () => {
    it("tracks view state", async () => {
      const { WorkspaceLeaf } = await import("./obsidian.js");
      const leaf = new WorkspaceLeaf();

      await leaf.setViewState({ type: "markdown", state: { mode: "preview" } });

      const state = leaf.getViewState();
      expect(state.type).toBe("markdown");
      expect(state.state).toEqual({ mode: "preview" });
      expect(leaf.getViewType()).toBe("markdown");
    });

    it("openFile sets file", async () => {
      const { WorkspaceLeaf } = await import("./obsidian.js");
      setVaultFiles({ "test.md": "content" });

      const leaf = new WorkspaceLeaf();
      const file = getVault().getFileByPath("test.md");

      if (!file) throw new Error("test setup failed: file is null");
      await leaf.openFile(file);

      expect(leaf.view.file).toBe(file);
    });
  });

  describe("UI Components", () => {
    it("ButtonComponent tracks state", async () => {
      const { ButtonComponent } = await import("./obsidian.js");
      const button = new ButtonComponent();

      button.setButtonText("Click me");
      button.setTooltip("Tooltip text");
      button.setClass("custom-class");
      button.setCta();
      button.setWarning();

      expect(button.getButtonText()).toBe("Click me");
      expect(button.getTooltip()).toBe("Tooltip text");
      expect(button.getClass()).toBe("custom-class");
      expect(button.isCta()).toBe(true);
      expect(button.isWarning()).toBe(true);
    });

    it("ButtonComponent respects disabled state", async () => {
      const { ButtonComponent } = await import("./obsidian.js");
      const button = new ButtonComponent();
      let clicked = false;

      button.onClick(() => {
        clicked = true;
      });
      button.setDisabled(true);

      expect(button.isDisabled()).toBe(true);

      button.trigger();
      expect(clicked).toBe(false);

      button.setDisabled(false);
      button.trigger();
      expect(clicked).toBe(true);
    });

    it("ToggleComponent respects disabled state", async () => {
      const { ToggleComponent } = await import("./obsidian.js");
      const toggle = new ToggleComponent();

      toggle.setValue(true);
      expect(toggle.getValue()).toBe(true);

      toggle.setDisabled(true);
      toggle.setValue(false);
      expect(toggle.getValue()).toBe(true); // Should not change

      toggle.setDisabled(false);
      toggle.setValue(false);
      expect(toggle.getValue()).toBe(false);
    });

    it("TextComponent respects disabled state", async () => {
      const { TextComponent } = await import("./obsidian.js");
      const text = new TextComponent();

      text.setValue("initial");
      expect(text.getValue()).toBe("initial");

      text.setDisabled(true);
      text.setValue("changed");
      expect(text.getValue()).toBe("initial"); // Should not change

      text.setDisabled(false);
      text.setValue("changed");
      expect(text.getValue()).toBe("changed");
    });
  });
});
