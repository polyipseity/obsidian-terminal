import { vi } from "vitest";

/*
Use `mocks/obsidian.ts` for the default Obsidian API mock, which provides basic stubs for all API methods.
Tests can override specific methods by doMock-ing "obsidian" themselves if needed.
*/
vi.mock("obsidian", async () => await vi.importActual("./mocks/obsidian.js"));
