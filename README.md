# PLACEHOLDER for Obsidian [![release](https://img.shields.io/github/v/release/polyipseity/obsidian-plugin-template)][latest release] [![Obsidian downloads](https://img.shields.io/badge/dynamic/json?logo=Obsidian&color=%238b6cef&label=downloads&query=$["PLACEHOLDER"].downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json)][community plugin]

To apply this [Obsidian] plugin template, replace all occurrences of `PLACEHOLDER` and `obsidian-plugin-template`.

[Obsidian]: https://obsidian.md/
[changelog]: https://github.com/polyipseity/obsidian-plugin-template/blob/main/CHANGELOG.md
[community plugin]: https://obsidian.md/plugins?id=PLACEHOLDER
[latest release]: https://github.com/polyipseity/obsidian-plugin-template/releases/latest
[repository]: https://github.com/polyipseity/obsidian-plugin-template
[trailer]: https://raw.githubusercontent.com/polyipseity/obsidian-plugin-template/main/assets/trailer.png

PLACEHOLDER

__[Repository] · [Changelog] · [Community plugin] · [Features](#features) · [Installation](#installation) · [Usage](#usage) · [Contributing](#contributing) · [Security](#security)__

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
        2. Install [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).
        3. Run `npm install` in the root directory.
        4. Run `npm run obsidian:install <vault directory>` in the root directory.
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

- __markdownlint__: Lints Markdown files. Run with `pnpm run markdownlint` or auto-fix with `pnpm run markdownlint:fix`.
- __commitlint__: Enforces conventional commit messages. Used automatically on commit via Husky.
- __husky__: Manages Git hooks. Pre-commit runs `lint-staged` and pre-push runs commitlint.
- __lint-staged__: Runs linters on staged files. Markdown files are auto-fixed before commit.

To set up locally:

1. Run `pnpm install` to install dependencies and set up hooks.
2. On commit, staged Markdown files will be linted and auto-fixed.
3. Commit messages are checked for conventional format.

You can manually run:

- `pnpm run markdownlint` — check all Markdown files
- `pnpm run markdownlint:fix` — auto-fix Markdown files
- `pnpm run commitlint` — check commit messages in range

Configuration files:

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
