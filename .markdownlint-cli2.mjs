// Shared markdown file globs. Exported so other configs (for example,
// lint-staged) can reuse the same list and avoid duplication.
export const FILE_GLOB = "**/*.{md,mdoc,mdown,mdx,mkd,mkdn,markdown,rmd}";

// Re-export the default object with the same shape as before but referencing
// `FILE_GLOB` for the `globs` property.
export default {
  // List markdown file globs individually instead of using brace-style expansion.
  // This ensures consistent matching across platforms and makes it easy to
  // add or remove specific patterns in the future.
  globs: [FILE_GLOB],
  // Use repository gitignore to exclude files (faster for large trees)
  gitignore: true,
};
