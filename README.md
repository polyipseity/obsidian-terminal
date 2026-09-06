# Terminal for Obsidian [![release](https://img.shields.io/github/v/release/polyipseity/obsidian-terminal)][latest release] [![Obsidian downloads](https://img.shields.io/badge/dynamic/json?logo=Obsidian&color=%238b6cef&label=downloads&query=$["terminal"].downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json)][community plugin] [![Python](https://img.shields.io/badge/Python-≥3.9-gold?labelColor=blue&logo=Python&logoColor=white)][Python]

Integrate consoles, shells, and terminals inside [Obsidian].

[![Buy Me a Coffee/embed][Buy Me a Coffee/embed]][Buy Me a Coffee]

[Repository][repository] · [Changelog][changelog] · [Community plugin][community plugin] · [Related][related] · [Features](#features) · [Installation](#installation) · [Usage](#usage) · [Contributing](#contributing) · [Security](#security)

![Trailer][trailer]

For first time users, read the [installation](#installation) section first!

This file is automatically opened on first install. You can reopen it in settings or command palette.

## Features

- Start external terminals from Obsidian.
- Integrate terminals into Obsidian.
- Has an emulated developer console usable on all platforms.
- Supports multiple terminal profiles.
- Has built-in keyboard shortcuts.
- Automatically save and restore integrated terminal history.
- Find in terminal.
- Save terminal history as file.
- Customize terminal appearance.

## Installation

1. Install plugin.
   - Community plugins
     1. Install the [plugin][community plugin] from community plugins directly.
   - Manual
     1. Create directory `terminal` under `.obsidian/plugins` of your vault.
     2. Place `manifest.json`, `main.js`, and `styles.css` from the [latest release] into the directory.
   - Building (rolling)
     1. Clone this repository, including its submodules.
     2. Install [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/).
     3. Run `bun install` in the root directory.
     4. Run `uv sync --locked` in the root directory.
     5. Run `bun run obsidian:install <vault directory>` in the root directory.
   - [Obsidian42 - BRAT](https://obsidian.md/plugins?id=obsidian42-brat) (rolling)
     - See [their readme](https://github.com/TfTHacker/obsidian42-brat#readme).
2. (optional for Windows, recommended) Install Python.
   1. Install [Python] 3.9 or above. The default ConPTY backend needs no pip packages; the ConHost backend's resizer additionally needs `pip3 install psutil pywinctl typing_extensions`. <!-- Update `README.md`, `magic.ts`, `pyproject.toml`, and `dependabot.yml` together. -->
   2. On Windows the plugin detects Python by itself and shows the result in the plugin settings, where you can also set the interpreter once for every profile; a profile's own Python field overrides it. On other platforms, configure the Python executable per profile and press the "Check" button to validate it.
3. Enable plugin.
4. (optional) Configure plugin settings.

## Usage

- To start a new external or integrated terminal
  - Ribbon
    1. Click on the `Open terminal` ribbon.
    2. Opens the default terminal if you have set up one. Otherwise, choose the desired profile.
  - Context menu
    1. Right-click on files, folders, or tab headers.
    2. Choose the desired action \(and profile\).
  - Command palette
    1. Press `Ctrl`+`P` or click on the `Open command palette` ribbon next to the left window border.
    2. Choose the desired action \(and profile\).
  - Select profile modal
    1. Choose the desired profile. Press `Ctrl` to edit the profile before use. The item `(Temporary profile)` starts a terminal with a temporary profile.
- To save and restore integrated terminal history
  1. Keep the terminal open when exiting Obsidian.
  2. Terminal history will be restored next time Obsidian is opened.
- Additional actions
  - Includes
    - Clear terminal: \(1\), \(4\)
    - Copy terminal: \(1\)
    - Edit terminal: \(1\)
    - Export, import, or edit settings: \(2\), \(3\)
    - Find in terminal: \(1\), \(4\)
    - Open documentation: \(2\), \(3\)
    - Restart terminal: \(1\)
    - Save terminal history: \(1\)
  - Available by
    - \(1\) Right-click on tab header/`More options`
    - \(2\) Open settings
    - \(3\) Open command palette
    - \(4\) Use keyboard shortcuts

### Keyboard shortcuts

The keyboard shortcuts can be customized in hotkeys settings.

#### Global

- Toggle focus on last terminal: `Ctrl`+`Shift`+`` ` ``
  - Focus on last terminal: \(unbound; useful if you want separate keys for focus and unfocus\)

#### Terminal is focused

When a terminal is focused, other keyboard shortcuts \(including Obsidian and plugin hotkeys\) are disabled. Only the following keyboard shortcuts work. Thus you can ignore Obsidian complaining about conflicting keys for the following keyboard shortcuts.

This behavior can be turned off via the `Intercept keys when terminal is focused` setting; when disabled, Obsidian hotkeys keep working while the terminal has focus.

- Clear terminal: `Ctrl`+`Shift`+`K`, `Command`+`Shift`+`K` \(Apple\)
- Close terminal: `Ctrl`+`Shift`+`W`, `Command`+`Shift`+`W` \(Apple\)
- Find in terminal: `Ctrl`+`Shift`+`F`, `Command`+`Shift`+`F` \(Apple\)
- Toggle focus on last terminal: `Ctrl`+`Shift`+`` ` `` \(same as above\)
  - Unfocus terminal: \(unbound; useful if you want separate keys for focus and unfocus\)

### Theming

Theming is possible. However, there is no user-friendly interface for now.

1. Open the profile editing modal.
2. Click on the `Edit` button labeled `Data`. It should open up a new modal in which there is a large textbox.
3. Notice `terminalOptions` in the text area labeled `Data`. Refer to the [`xterm.js` documentation](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts#L26) (`ITerminalOptions`) to set the options. Nested objects may need to be used.
   - You can also configure global defaults via the plugin settings page (see `Profile defaults`). Those options act as a fallback for every profile unless a profile explicitly overrides them.
4. Save the profile. Changes should apply immediately.

### Profiles

This plugin comes with several profile presets that you can reference.

When setting up a terminal profile, you need to distinguish between shells and terminal emulators. (Search online if needed.) Generally, integrated profiles only work with shells while external ones only work with terminal emulators.

#### Examples

##### Shells

- Bash: `bash --login`
- Bourne shell: `sh`
- Command Prompt: `cmd`
- Dash: `dash`
- Git Bash: `<Git installation>\bin\bash.exe --login` (e.g. `C:\Program Files\Git\bin\bash.exe`)
- PowerShell Core: `pwsh`
- Windows PowerShell: `powershell`
- Windows Subsystem for Linux: `wsl` or `wsl -d <distribution name>`
- Z shell: `zsh --login`

##### Terminal emulators

- Command Prompt: `cmd`
- GNOME Terminal: `gnome-terminal`
- Konsole: `konsole`
- Terminal (macOS): `/System/Applications/Utilities/Terminal.app/Contents/macOS/Terminal "$PWD"`
- Windows Terminal: `wt`
- iTerm2: `/Applications/iTerm.app/Contents/MacOS/iTerm2 "$PWD"`
- xterm: `xterm`

### Miscellaneous

This plugin patches `require` so that `require("obsidian")` and other Obsidian modules work in the developer console. It is toggleable as `Expose internal modules` in settings.

In the developer console, a context variable `$$` is passed into the code, which can be used to dynamically change terminal options.

The full API is available from [`src/@types/obsidian-terminal.ts`](src/%40types/obsidian-terminal.ts).

### Troubleshooting

- Is the plugin useful on mobile?
  - Compared to on desktop, it is much less useful. The only use for it for now is opening a developer console on mobile.
- Why do hotkeys not work?
  - If the terminal is in focus, all Obsidian hotkeys are disabled so that you can type special characters into the terminal. You can unfocus the terminal by pressing `Ctrl`+`Shift`+`` ` ``, then you can use Obsidian hotkeys again. Alternatively, disable the `Intercept keys when terminal is focused` setting to keep Obsidian hotkeys working while the terminal has focus.

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

### Checks, formatting, and hooks

`package.json` defines the executable workflow:

- `bun run check` runs TypeScript, ESLint, markdownlint, Prettier, Ruff, and Ty checks.
- `bun run format` applies ESLint, markdownlint, Prettier, and Ruff fixes, then runs Ty.
- `bun run build` runs `bun run check`, then creates the production bundle.
- `bun run build:dev` starts the development watcher without running the checks.
- `bun run commitlint` checks commits from `origin/main` through `HEAD`.

Prek manages the Git hooks in `prek.toml`. The pre-commit hooks format supported files. The commit-message hook runs commitlint. The pre-push hook runs the full test suite.

To set up locally:

1. Install Bun and uv.
2. Run `bun install` to install JavaScript dependencies and Prek hooks.
3. Run `uv sync --locked` to install the locked Python environment.

Use these scoped commands when one check needs attention:

- `bun run check:tsc` — TypeScript type check
- `bun run check:eslint` — TypeScript and JavaScript lint
- `bun run check:md` — Markdown lint
- `bun run check:prettier` — Prettier check
- `bun run check:py` — Ruff formatting, Ruff lint, and Ty checks
- `bun run format:eslint` — ESLint fixes
- `bun run format:md` — Markdown fixes
- `bun run format:prettier` — Prettier fixes
- `bun run format:py` — Ruff fixes and Ty check

Configuration files:

- `eslint.config.mjs` — ESLint rules
- `.prettierrc.mjs` — Prettier rules
- `.prettierignore` — Prettier ignore patterns
- `.markdownlint.jsonc` — markdownlint rules
- `.markdownlint-cli2.mjs` — markdownlint file selection
- `.commitlintrc.mjs` — commitlint config
- `prek.toml` — Git hooks

### Testing

This repository uses Pytest for Python tests and Vitest for TypeScript and JavaScript tests.

- Run every non-interactive test with coverage: `bun run test`.
- Run only Python tests: `bun run test:py`.
- Run only Vitest tests: `bun run test:vitest`.
- Run Vitest interactively: `bun run test:watch`.
- The Prek pre-push hook runs `bun run test` and blocks a push when a test fails.

See `vitest.config.mts` for minimal config and further instructions.

### Windows backend tests

The ConPTY host and ConHost resizer tests run on native Windows only. See
[Windows backend tests](AGENTS.md#windows-backend-tests).

### Todos

The todos here, ordered alphabetically, are things planned for the plugin. There are no guarantees that they will be completed. However, we are likely to accept contributions for them.

- Connect to remote shells.
- Detect sandboxed environment and notify users.
- External link confirmation.
- Filter console log by severity in the developer console.
- Indicate that the terminal resizer has crashed or is disabled.
- Shared terminal tabs.
- Vim mode switch.

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

Please report a vulnerability by opening a [private vulnerability report][new security advisory]. We will get back to you as soon as possible.

[Buy Me a Coffee]: https://buymeacoffee.com/polyipseity
[Buy Me a Coffee/embed]: https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=polyipseity&button_colour=40DCA5&font_colour=ffffff&font_family=Lato&outline_colour=000000&coffee_colour=FFDD00
[changelog]: https://github.com/polyipseity/obsidian-terminal/blob/main/CHANGELOG.md
[community plugin]: https://obsidian.md/plugins?id=terminal
[latest release]: https://github.com/polyipseity/obsidian-terminal/releases/latest
[new security advisory]: https://github.com/polyipseity/obsidian-terminal/security/advisories/new
[Obsidian]: https://obsidian.md/
[Python]: https://python.org/downloads/
[related]: https://github.com/polyipseity/obsidian-monorepo
[repository]: https://github.com/polyipseity/obsidian-terminal
[trailer]: https://raw.githubusercontent.com/polyipseity/obsidian-terminal/main/assets/trailer.png
