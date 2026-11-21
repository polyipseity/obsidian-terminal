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
- Show program status on terminal tabs.

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
   1. Install [Python] 3.9 or above. The default ConPTY backend needs no pip packages; the ConHost backend's resizer additionally needs Python packages. Use the profile's "Copy install command" button and run the command in PowerShell, or run `python -m pip install --upgrade "psutil>=5.9.5" "pywinctl>=0.0.50" "typing_extensions>=4.7.1"` if your profile uses `python`. <!-- Keep package minimums in sync with the runtime source, `src/python-requirements.json`. -->
   2. On Windows, the plugin tries the profile's Python interpreter, then the interpreter in the plugin settings, then `python`, `python3`, and `py -3`, using the first working interpreter. Stored profile values stay unchanged. An empty profile Python field no longer disables Python on Windows; the ConHost resizer runs whenever a usable Python with its packages is found, and there is no setting to turn it off. If ConPTY is selected but no usable Python is found, its ConPTY host cannot be confirmed, or the host already failed with this Python configuration, that terminal opens with ConHost. If the ConPTY host fails while a terminal starts, that terminal shows an error and later terminals open with ConHost. The saved backend stays ConPTY; after installing or repairing Python, select "Recheck Python" in the plugin settings (or restart Obsidian) to retry ConPTY. On other platforms, configure the Python executable per profile and press the "Check" button to validate it.
   3. On Windows, ConPTY terminals run on the console host that Windows Terminal ships (`OpenConsole.exe`) when Windows Terminal 1.22 or newer is installed, which passes more terminal replies to programs. Otherwise, or when it cannot start, they use the console host built into Windows. To always use the built-in one, turn off "Windows Terminal console host" in the plugin settings.
   4. On Windows, closing a ConPTY terminal or quitting Obsidian also ends the console programs the shell left running in a console of their own, hidden or visible. Such a console program keeps running if a program with a window is running under it when the terminal closes, for example a Python app with a window that you started in it. Apps that hand their window to another process, such as `code .` and `explorer .`, do not count. Programs with a window, programs started without a console (`DETACHED_PROCESS`), and whatever runs under either keep running; a program still running in the terminal is closed by the console host as before. To keep a console program running after the terminal closes, start it without a console, or start it from a program with a window and leave that program open until then.
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
- To insert the path of a file or folder
  1. Drag it onto an integrated terminal, from the vault or from another app such as Finder, Explorer or VS Code.
  2. The path is escaped or quoted for the shell of the terminal's profile, and a notice says so when something could not be inserted.
- Additional actions
  - Includes
    - Clear terminal: \(1\), \(3\), \(4\)
    - Close terminal: \(3\), \(4\)
    - Copy terminal: \(1\)
    - Edit terminal: \(1\)
    - Export, import, or edit settings: \(2\), \(3\)
    - Find in terminal: \(1\), \(3\), \(4\)
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
- Open current directory in terminal \(integrated\): `Ctrl`+`Shift`+`H`, `Command`+`Shift`+`H` \(Apple\)
  - It opens the default profile when that profile is integrated and runs on this platform, and otherwise the first integrated profile in the profile list that does. The other commands and menu items for one profile type work the same way.
  - Another plugin may use the same keys. Obsidian then shows a conflict, which you can resolve under Settings → Hotkeys.

#### Terminal is focused

When a terminal is focused, other keyboard shortcuts \(including Obsidian and plugin hotkeys\) are disabled. Only the following keyboard shortcuts work. Thus you can ignore Obsidian complaining about conflicting keys for the following keyboard shortcuts.

This behavior can be turned off via the `Intercept keys when terminal is focused` setting; when disabled, Obsidian hotkeys keep working while the terminal has focus.

- Clear terminal: `Ctrl`+`Shift`+`K`, `Command`+`Shift`+`K` \(Apple\)
- Close terminal: `Ctrl`+`Shift`+`W`, `Command`+`Shift`+`W` \(Apple\)
- Find in terminal: `Ctrl`+`Shift`+`F`, `Command`+`Shift`+`F` \(Apple\)
- Toggle focus on last terminal: `Ctrl`+`Shift`+`` ` `` \(same as above\)
  - Unfocus terminal: \(unbound; useful if you want separate keys for focus and unfocus\)
- Command palette: `Ctrl`+`P` \(Windows\), `Command`+`P` \(Apple\)
  - These keys are keymappings with the action `Send to Obsidian` \(Settings → Keymappings\). Obsidian runs its hotkey for a key with that action, and the shell does not get the key. Map more keys to it, or delete an entry to give its key back to the shell. On Windows, the entry keeps `Ctrl`+`P` from all programs in the terminal, such as bash in WSL, Git Bash and SSH sessions, and vim and nano. Linux has no such entry, because bash and zsh use `Ctrl`+`P`.
  - If another device that syncs this vault still runs 3.29.0 or older, a deleted entry comes back each time this device starts after that one saved its settings, which it does at each start. To keep the key in the shell, set the entry's action to `Passthrough` instead of deleting it.
  - A keymapping matches the character a key types. With Caps Lock on, or on a layout where the key types another letter, `Ctrl`+`P` goes to the shell.
- Open root directory or current directory in terminal \(default, external, integrated, select\) and open developer console: \(unbound, except open current directory in terminal \(integrated\) above; a hotkey you assign also works here\)
  - A hotkey of one of these commands, the default above or one you assign, works everywhere in Obsidian. In a focused terminal it wins over a default shortcut of this list on the same keys, so do not ignore a conflict that Obsidian reports for it.
  - The commands that open the current directory use the folder of the active file. Without one, for example in a focused terminal, on an empty tab or in the graph view, they use the folder of the file you looked at last, and the vault root when no file is open or recently opened. Their hotkeys do not reach the shell.
  - With `Add to command` off, these commands do nothing. In a focused terminal their hotkeys, the default above included, then go to the shell.

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

The profiles sync with your vault, but the default profile and the order of the profile list belong to each device. Choosing a default or moving a profile on one device leaves your other devices as they are. On a new device, after Obsidian's local storage is cleared, or after going back to an older version of the plugin, choose the default profile again. Undo, Reload and Reset under All settings change only the synced settings, not this device's default profile and order. If they remove the profile that is this device's default, choose a default again. The `defaultProfile` value in the plugin's settings file is kept only for devices that run an older version of the plugin.

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

### Program status on tabs

Terminal tabs show the plugin's own icon at 21 px, larger than Obsidian's own tab icons. A tab in a sidebar keeps Obsidian's size. With `Program status` at `None` the icon is a rounded square, the same as on the `Open terminal` ribbon button. With `Still` or `Animated` it is a square with a raised border, which carries the status marks.

`Program status`, in the `Interface` section of the plugin settings, shows on a terminal tab what the program in it reports with the escape sequence OSC 7501: idle, working, needs input, finished or error.

- `None`: no status is shown and the reports are ignored.
- `Still`: the tab icon gets a mark for the status. Nothing moves.
- `Animated` (default): the same marks, and the working dots light up in turn, a changed tab title slides up from below, and a new finished, needs-input or error mark pops in. Nothing moves where the system asks for reduced motion. On Windows that is `Animation effects` turned off under `Settings` > `Accessibility` > `Visual effects`.

A finished program stays marked until you look at its terminal. A program that does not send OSC 7501 shows no status. Inside tmux or screen, a report reaches the terminal only when passthrough is set up there. On Windows, a program that asks the terminal whether it understands the reports gets an answer only on Windows Terminal's console host, which ConPTY terminals use when Windows Terminal 1.22 or newer is installed and `Windows Terminal console host` is on (the default). On the console host built into Windows (tested on Windows 11 24H2) and on the ConHost backend it gets no answer, so a program that waits for that answer before it reports shows no status there. A program that was already running when you choose `Still` or `Animated` may report only after you restart it.

The setting is stored with the other plugin settings, so it follows the vault to every device that syncs them. A device that runs 3.28.0 or earlier drops the `tabStatus` setting when it saves its settings, so `Program status` goes back to `Animated`, the default.

### Experimental features

Features that are not finished are listed under `Experimental`, the last section of the plugin settings. The section is shown only when the installed version has such features.

- Every experimental feature is off until you turn it on. An update never turns one on.
- Each row says what the feature does, what the known risk is, and where to send feedback.
- To try a feature, turn on its toggle. To stop, turn it off. The plugin then behaves as it did before, and nothing you stored is lost. A change applies at once unless the row says it needs new terminals or a restart.
- An experimental feature may change or be removed in a later version. When one becomes a regular feature, its toggle leaves the section and the changelog says so.
- The choice is stored with the other plugin settings, so it follows the vault to every device that syncs them. A device that still runs an older version turns the feature off again and resets its options when it saves its settings, because that version drops settings it does not know.

### Miscellaneous

This plugin patches `require` so that `require("obsidian")` and other Obsidian modules work in the developer console. It is toggleable as `Expose internal modules` in settings.

In the developer console, a context variable `$$` is passed into the code, which can be used to dynamically change terminal options.

The full API is available from [`src/@types/obsidian-terminal.ts`](src/%40types/obsidian-terminal.ts).

### Troubleshooting

- Is the plugin useful on mobile?
  - Compared to on desktop, it is much less useful. The only use for it for now is opening a developer console on mobile.
- Why do hotkeys not work?
  - If the terminal is in focus, all Obsidian hotkeys are disabled so that you can type special characters into the terminal. You can unfocus the terminal by pressing `Ctrl`+`Shift`+`` ` ``, then you can use Obsidian hotkeys again. Alternatively, disable the `Intercept keys when terminal is focused` setting to keep Obsidian hotkeys working while the terminal has focus. To let one key through, map it to the keymapping action `Send to Obsidian`, as the built-in `Ctrl`+`P` on Windows and `Command`+`P` on macOS are.

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

### System access

Obsidian's [community Scorecard][community plugin scorecard] flags the plugin for reading system information and for using Node.js `fs`. A terminal cannot work without them:

- **Environment variables.** Terminals inherit Obsidian's environment, such as `HOME` and `PATH`. The plugin removes variables left by the terminal or editor Obsidian was started from (such as `TMUX` and `VSCODE_*`) and, for integrated terminals, sets `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, and `PYTHONIOENCODING`. Your profile's variables are applied last. The environment goes only to the processes the plugin starts.
- **System `PATH` and Windows version.** Obsidian started from a desktop launcher often has a short `PATH`. To find shells and Python, the plugin adds the system `PATH`: from `/usr/libexec/path_helper` on macOS, `/etc/environment` or `getconf PATH` on Linux, and the registry on Windows. On Windows, it also reads the OS build number, which tells the terminal display how ConPTY wraps lines.
- **Files outside the vault.** The plugin runs the shells, terminal emulators, and Python interpreters named in your profiles or settings. On Windows, when no configured Python executable works, it tries `python`, `python3`, and the `py` launcher (run with `-3`) from `PATH`. On Windows, it writes the ConPTY host script (`obsidian-terminal-conpty-*.py`) to the system temporary folder and keeps it for later sessions. With the ConHost backend, it also writes a short `.bat` file to that folder, which starts the program and records its exit code through a second `C:\Windows\System32\cmd.exe /d`, and deletes that file when the terminal exits. The program and its arguments reach that file through the environment of `conhost.exe`, and the file clears them before the program starts. With the Windows Terminal console host setting on (the default), the ConPTY host script asks Windows where the installed Windows Terminal packages are, through the documented package API (`GetPackagesByPackageFamily` and `GetPackagePathByFullName`), and starts the `OpenConsole.exe` it finds there. Windows does not let other programs start files inside Windows Terminal's install folder, so the script copies that `OpenConsole.exe` to `%LOCALAPPDATA%\obsidian-terminal\console-host` and starts the copy. When a drop on a terminal names files by URI, as a drag out of VS Code does, it asks the file system whether each path is a file or a folder before it inserts the path. It does not read the files.

### Supported versions

| Version  | Supported |
| -------- | --------- |
| rolling  | ✅        |
| latest   | ✅        |
| outdated | ❌        |

### Reporting a vulnerability

Please report a vulnerability by opening a [private vulnerability report][new security advisory]. We will get back to you as soon as possible.

## Credits

The idle mark on terminal tabs is the moon of Phosphor Icons (MIT License, Copyright (c) 2023 Phosphor Icons).

[Buy Me a Coffee]: https://buymeacoffee.com/polyipseity
[Buy Me a Coffee/embed]: https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=polyipseity&button_colour=40DCA5&font_colour=ffffff&font_family=Lato&outline_colour=000000&coffee_colour=FFDD00
[changelog]: https://github.com/polyipseity/obsidian-terminal/blob/main/CHANGELOG.md
[community plugin]: https://obsidian.md/plugins?id=terminal
[community plugin scorecard]: https://community.obsidian.md/plugins/terminal#scorecard
[latest release]: https://github.com/polyipseity/obsidian-terminal/releases/latest
[new security advisory]: https://github.com/polyipseity/obsidian-terminal/security/advisories/new
[Obsidian]: https://obsidian.md/
[Python]: https://python.org/downloads/
[related]: https://github.com/polyipseity/obsidian-monorepo
[repository]: https://github.com/polyipseity/obsidian-terminal
[trailer]: https://raw.githubusercontent.com/polyipseity/obsidian-terminal/main/assets/trailer.png
