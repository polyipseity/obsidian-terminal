import config from './.markdownlint.json' with { type: 'json' };

export default {
  // export the imported object as the `config` property so the loader
  // matches the expected shape: { config: { ...rules }, ... }
  config,
  globs: ["**/*.md"],
  // Use repository gitignore to exclude files (faster for large trees)
  gitignore: true
};
