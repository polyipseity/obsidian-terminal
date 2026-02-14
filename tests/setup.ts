import { beforeEach, vi } from "vitest";

beforeEach(() => {
  // Clears the cache for all modules
  vi.resetModules();
  // Optional: Also clears all mocks
  vi.clearAllMocks();
});

// Use `mocks/obsidian.ts` for the default Obsidian API mock, which provides basic stubs for all API methods.
// Tests can override specific methods by doMock-ing "obsidian" themselves if needed.
vi.mock("obsidian", async () => await import("./mocks/obsidian.js"));
