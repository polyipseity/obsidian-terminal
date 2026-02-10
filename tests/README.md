# Vitest guidelines and `vi` best practices

This file documents recommended patterns for tests in this package. It mirrors the short guidance added to `AGENTS.md` and provides canonical examples.

## Key recommendations

- Prefer `vi.fn()` for spies/stubs. Use `vi.fn().mockResolvedValue(x)` or `vi.fn().mockRejectedValue(err)` for async stubs.
- Use `vi.spyOn` to observe global/stateful functions (console, process, etc.).
- Keep mocks isolated: use `vi.doMock(...)` + `vi.resetModules()` for module-level mocks and `vi.restoreAllMocks()` in `afterEach` for cleanup.
- For timer-related tests, prefer `vi.useFakeTimers()` and deterministic time control.
- For typed module mocks use `vi.mocked(await import(...))` to obtain a typed reference to the mocked module.

## Example snippets

```ts
// typed import/get mock
const lib = vi.mocked(await import("@polyipseity/obsidian-plugin-library"));

// async stub
const open = vi.fn().mockResolvedValue(undefined);

// use helper for DocumentationMarkdownView.register
await overrideDocumentationRegister(makeDocView({ open }));

// cleanup
afterEach(() => {
  vi.restoreAllMocks();
});
```
