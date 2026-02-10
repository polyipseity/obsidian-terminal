import { vi } from "vitest";
import type { DocumentationMarkdownView } from "@polyipseity/obsidian-plugin-library";
import type { DocView } from "../helpers.js";

// Helper to return the typed mocked library module
export async function libMocked() {
  return vi.mocked(await import("@polyipseity/obsidian-plugin-library"));
}

// Convenience helper to override DocumentationMarkdownView.register to return `view`.
// Accepts a loose DocView or a partial of the registered view and casts safely.
export async function overrideDocumentationRegister(
  view: DocView | Partial<DocumentationMarkdownView.Registered>,
) {
  const lib = await libMocked();
  Object.assign(lib.DocumentationMarkdownView, {
    register: vi.fn(
      () => view as unknown as DocumentationMarkdownView.Registered,
    ),
  });
}
