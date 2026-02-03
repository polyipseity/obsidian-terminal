# PLACEHOLDER for Obsidian [![release](https://img.shields.io/github/v/release/polyipseity/obsidian-plugin-template)][latest release] [![Obsidian downloads](https://img.shields.io/badge/dynamic/json?logo=Obsidian&color=%238b6cef&label=downloads&query=$["PLACEHOLDER"].downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json)][community plugin]

To apply this [Obsidian] plugin template, replace all occurrences of `PLACEHOLDER` and `obsidian-plugin-template`.

[Buy Me a Coffee]: https://buymeacoffee.com/polyipseity
[Buy Me a Coffee/embed]: https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=polyipseity&button_colour=40DCA5&font_colour=ffffff&font_family=Lato&outline_colour=000000&coffee_colour=FFDD00
[Obsidian]: https://obsidian.md/
[changelog]: https://github.com/polyipseity/obsidian-plugin-template/blob/main/CHANGELOG.md
[community plugin]: https://obsidian.md/plugins?id=PLACEHOLDER
[latest release]: https://github.com/polyipseity/obsidian-plugin-template/releases/latest
[repository]: https://github.com/polyipseity/obsidian-plugin-template
[trailer]: https://raw.githubusercontent.com/polyipseity/obsidian-plugin-template/main/assets/trailer.png
[related]: https://github.com/polyipseity/obsidian-monorepo

PLACEHOLDER

[![Buy Me a Coffee/embed]][Buy Me a Coffee]

__[Repository] · [Changelog] · [Community plugin] · [Related] · [Features](#features) · [Installation](#installation) · [Usage](#usage) · [Contributing](#contributing) · [Security](#security)__

![Trailer]

For first time users, read the [installation](#installation) section first!

This file is automatically opened on first install. You can reopen it in settings or command palette.

## Features

- PLACEHOLDER

## Installation

1. Install plugin.
    - Community plugins
        1. Install the [plugin][community plugin] from community plugins directly.
    - Manual
        1. Create directory `PLACEHOLDER` under `.obsidian/plugins` of your vault.
        2. Place `manifest.json`, `main.js`, and `styles.css` from the [latest release] into the directory.
    - Building (rolling)
        1. Clone this repository, including its submodules.
        2. Install `pnpm` (preferred) or `npm`. See <https://pnpm.io/installation> for pnpm.
        3. Run `pnpm install` in the root directory (`npm install` is an acceptable fallback).
        4. Run `pnpm obsidian:install <vault directory>` in the root directory (`npm run obsidian:install <vault directory>` is an acceptable fallback).
    - [Obsidian42 - BRAT](https://obsidian.md/plugins?id=obsidian42-brat) (rolling)
        - See [their readme](https://github.com/TfTHacker/obsidian42-brat#readme).
2. Enable plugin.
3. (optional) Configure plugin settings.

## Usage

- PLACEHOLDER

## Contributing

Contributions are welcome!

### Changesets

This project uses [`changesets`](https://github.com/changesets/changesets) to manage the changelog. When creating a pull request, please [add a changeset](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md#adding-changesets) describing the changes. Add multiple changesets if your pull request changes several things. End each changeset with `([PR number](PR link) by [author username](author link))`. For example, the newly created file under the directory `.changeset` should look like:

```Markdown
---
"example": patch
---

This is an example change. ([GH#1](https://github.com/ghost/example/pull/1) by [@ghost](https://github.com/ghost))
```

### Linting, Commit, and Hooks

This project uses the following tools to ensure code and commit quality:

- __ESLint__: Linting for TypeScript/JavaScript. Run with `pnpm run check` (lint only) or `pnpm run fix` (auto-fix lint issues).
- __Prettier__: Code formatting. Run with `pnpm run format` (format all files) or `pnpm run format:check` (check formatting only).
- __markdownlint__: Lints Markdown files. Run with `pnpm run markdownlint` or auto-fix with `pnpm run markdownlint:fix`.
- __commitlint__: Enforces conventional commit messages. Used automatically on commit via Husky.
- __husky__: Manages Git hooks. Pre-commit runs `lint-staged` and pre-push runs commitlint.
- __lint-staged__: Runs linters on staged files. Markdown files are auto-fixed before commit.

> **Lint-staged note:** The lint-staged configuration (`.lintstagedrc.mjs`) invokes formatter/linter binaries directly (for example `prettier --write`, `eslint --cache --fix`, `markdownlint-cli2 --fix`) so that the list of staged files is passed through to the tool. Invoking these via `npm run` would prevent lint-staged from forwarding filenames and cause the tool to operate on its default glob (or the entire repo). Use `pnpm run format` to format the entire repository when needed.

To set up locally:

1. Run `pnpm install` to install dependencies and set up hooks.
2. On commit, staged Markdown files will be linted and auto-fixed.
3. Commit messages are checked for conventional format.

You can manually run:

- `pnpm run check` — lint all code (no formatting)
- `pnpm run fix` — auto-fix lint issues (no formatting)
- `pnpm run format` — format all code with Prettier
- `pnpm run format:check` — check formatting with Prettier
- `pnpm run markdownlint` — check all Markdown files
- `pnpm run markdownlint:fix` — auto-fix Markdown files
- `pnpm run commitlint` — check commit messages in range

Configuration files:

- `.eslintrc.*` or `eslint.config.mjs` — ESLint rules
- `.prettierrc` — Prettier rules
- `.prettierignore` — Prettier ignore patterns
- `.markdownlint.json` — markdownlint rules
- `.commitlintrc.js` — commitlint config
- `.husky/` — Git hooks

### Todos

The todos here, ordered alphabetically, are things planned for the plugin. There are no guarantees that they will be completed. However, we are likely to accept contributions for them.

- PLACEHOLDER

### Translating

See [`assets/locales/README.md`](assets/locales/README.md).

## Security

We hope that there will never be any security vulnerabilities, but unfortunately it does happen. Please [report](#reporting-a-vulnerability) them!

### Supported versions

| Version  | Supported |
| -------- | --------- |
| rolling  | ✅        |
| latest   | ✅        |
| outdated | ❌        |

### Reporting a vulnerability

Please report a vulnerability by opening an new issue. We will get back to you as soon as possible.
