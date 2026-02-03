import config from './.markdownlint.json' with { type: 'json' };

export default {
  // export the imported object as the `config` property so the loader
  // matches the expected shape: { config: { ...rules }, ... }
  config,
  // List markdown file globs individually instead of using brace-style expansion.
  // This ensures consistent matching across platforms and makes it easy to
  // add or remove specific patterns in the future.
  globs: [
    "**/*.md",
    "**/*.mdoc",
    "**/*.mdown",
    "**/*.mdx",
    "**/*.mkd",
    "**/*.mkdn",
    "**/*.markdown",
    "**/*.rmd"
  ],
  // Use repository gitignore to exclude files (faster for large trees)
  gitignore: true
};
