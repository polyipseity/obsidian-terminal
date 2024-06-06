# Terminal for Obsidian [![release](https://img.shields.io/github/v/release/polyipseity/obsidian-terminal)][latest release] [![Obsidian downloads](https://img.shields.io/badge/dynamic/json?logo=Obsidian&color=%238b6cef&label=downloads&query=$["terminal"].downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json)][community plugin] [![Python](https://img.shields.io/badge/Python-≥3.10-gold?labelColor=blue&logo=Python&logoColor=white)][Python]

[Buy Me a Coffee]: https://buymeacoffee.com/polyipseity
[Buy Me a Coffee/embed]: https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=polyipseity&button_colour=40DCA5&font_colour=ffffff&font_family=Lato&outline_colour=000000&coffee_colour=FFDD00
[Obsidian]: https://obsidian.md/
[Python]: https://python.org/downloads/
[changelog]: https://github.com/polyipseity/obsidian-terminal/blob/main/CHANGELOG.md
[community plugin]: https://obsidian.md/plugins?id=terminal
[latest release]: https://github.com/polyipseity/obsidian-terminal/releases/latest
[other things]: https://github.com/polyipseity/obsidian-monorepo
[plugin library]: https://github.com/polyipseity/obsidian-plugin-library
[repository]: https://github.com/polyipseity/obsidian-terminal
[trailer]: https://raw.githubusercontent.com/polyipseity/obsidian-terminal/main/assets/trailer.png

Integrate consoles, shells, and terminals inside [Obsidian].

[![Buy Me a Coffee/embed]][Buy Me a Coffee]

__[Repository] · [Changelog] · [Community plugin] · [Other things] · [Features](#features) · [Installation](#installation) · [Usage](#usage) · [Contributing](#contributing) · [Security](#security)__

![Trailer]

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
    - Building (latest)
        1. Clone this repository, including its submodules.
        2. Install [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).
        3. Run `npm install` in the root directory.
        4. Run `npm run obsidian:install <vault directory>` in the root directory.
    - [Obsidian42 - BRAT](https://obsidian.md/plugins?id=obsidian42-brat) (latest)
        - See [their readme](https://github.com/TfTHacker/obsidian42-brat#readme).
2. (optional for Windows, recommended) Install Python and dependencies.
    1. Install [Python] 3.10/+.
    2. (Windows only) Run `pip3 install psutil==5.9.5 pywinctl==0.0.50 typing_extensions==4.7.1`. <!-- Update `README.md`, `magic.ts`, and `requirements.txt` together. -->
    3. Configure Python executable in plugin settings. Press the "Check" button to validate the Python configuration.
3. Enable plugin.
4. (optional) Configure plugin settings.

## Usage

- To start a new external or integrated terminal
  - Ribbon
        1. Click on the `Open terminal` ribbon.
        2. Choose the desired profile.
  - Context menu
        1. Right-click on files, folders, or tab headers.
        2. Choose the desired action (and profile).
  - Command palette
        1. Press `Ctrl`+`P` or click on the `Open command palette` ribbon next to the left window border.
        2. Choose the desired action (and profile).
- To save and restore integrated terminal history
    1. Keep the terminal open when exiting Obsidian.
    2. Terminal history will be restored next time Obsidian is opened.
- Additional actions
  - Includes
    - Find in terminal: (1), (4)
    - Clear terminal: (1), (4)
    - Restart terminal: (1)
    - Edit terminal: (1)
    - Save terminal history as file: (1)
    - Export, import, or edit settings: (2), (3)
    - Open documentation: (2), (3)
  - Available by
    - (1) Right-click on tab header/`More options`
    - (2) Open settings
    - (3) Open command palette
    - (4) Use keyboard shortcuts

### Keyboard shortcuts

The keyboard shortcuts are not customizable for now.

<!-- markdownlint-disable-next-line MD036 -->
__Terminal tab is focused__

- Focus: `Ctrl`+`Shift`+`` ` ``
- Inherits global keyboard shortcuts

<!-- markdownlint-disable-next-line MD036 -->
__Terminal is focused__

- Clear: `Ctrl`+`Shift`+`K`, `Command`+`K` (Apple)
- Close: `Ctrl`+`Shift`+`W`, `Command`+`W` (Apple)
- Find: `Ctrl`+`Shift`+`F`, `Command`+`F` (Apple)
- Toggle focus: `Ctrl`+`Shift`+`` ` ``

### Theming

Theming is possible. However, there is no user-friendly interface for now.

1. Open the profile editing modal.
2. Click on the `Edit` button labeled `Data`. It should open up a new modal in which there is a large textbox.
3. Notice `terminalOptions` in the text area labeled `Data`. Refer to the [`xterm.js` documentation](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts#L26) (`ITerminalOptions`) to set the options. Nested objects may need to be used.
4. Save the profile. Changes should apply immediately.

### Profiles

This plugin comes with several profile presets that you can reference.

When setting up a terminal profile, you need to distinguish between shells and terminal emulators. (Search online if needed.) Generally, integrated profiles only work with shells while external ones only work with terminal emulators.

#### Examples

<!-- markdownlint-disable-next-line MD036 -->
__Shells__

- Bash: `bash`
- Bourne shell: `sh`
- Command Prompt: `cmd`
- Dash: `dash`
- Git Bash: `<Git installation>\bin\bash.exe` (e.g. `C:\Program Files\Git\bin\bash.exe`)
- PowerShell Core: `pwsh`
- Windows PowerShell: `powershell`
- Windows Subsystem for Linux: `wsl` or `wsl -d <distribution name>`
- Z shell: `zsh`

<!-- markdownlint-disable-next-line MD036 -->
__Terminal emulators__

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

The full API is available from [`sources/@types/obsidian-terminal.ts`](sources/%40types/obsidian-terminal.ts).

### Troubleshooting

- Is the plugin useful on mobile?
  - Compared to on desktop, it is much less useful. The only use for it for now is opening a developer console on mobile.
- Why do hotkeys not work?
  - If the terminal is in focus, all Obsidian hotkeys are disabled so that you can type special characters into the terminal. You can unfocus the terminal by pressing `Ctrl`+`Shift`+`` ` ``, then you can use Obsidian hotkeys again.

## Contributing

Contributions are welcome!

This project uses [`changesets`](https://github.com/changesets/changesets) to manage the changelog. When creating a pull request, please [add a changeset](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md#adding-changesets) describing the changes. Add multiple changesets if your pull request changes several things. End each changeset with `([PR number](PR link) by [author username](author link))`. For example, the newly created file under the directory `.changeset` should look like:

```Markdown
---
"example": patch
---

This is an example change. ([GH#1](https://github.com/ghost/example/pull/1) by [@ghost](https://github.com/ghost))
```

### Todos

The todos here, ordered alphabetically, are things planned for the plugin. There are no guarantees that they will be completed. However, we are likely to accept contributions for them.

- Connect to remote shells.
- Copy terminal tabs.
- Create ad-hoc profile in `Open terminal: Select`.
- Detect sandboxed environment and notify users.
- Edit profile before opening terminal in `Open terminal: Select` when a modifier key is pressed.
- External link confirmation.
- Filter console log by severity in the developer console.
- Fix broken section links in builtin documentations.
- Indicate that the terminal resizer has crashed or is disabled.
- Shared terminal tabs.
- Vim mode switch.

### Translating

Translation files are under [`assets/locales/`](assets/locales/). Each locale has its own directory named with its corresponding __[IETF language tag](https://wikipedia.org/wiki/IETF_language_tag)__. Some translation keys are missing here and instead located at [`obsidian-plugin-library`][plugin library].

To contribute translation for an existing locale, modify the files in the corresponding directory.

For a new locale, create a new directory named with its language tag and copy [`assets/locales/en/translation.json`](assets/locales/en/translation.json) into it. Then, add an entry to [`assets/locales/en/language.json`](assets/locales/en/language.json) in this format:

```JSONc
{
    // ...
    "en": "English",
    "(your-language-tag)": "(Native name of your language)",
    "uwu": "Uwuish",
    // ...
}
```

Sort the list of languages by the alphabetical order of their language tags. Then modify the files in the new directory. There will be errors in [`assets/locales.ts`](assets/locales.ts), which you can ignore and we will fix them for you. You are welcome to fix them yourself if you know TypeScript.

When translating, keep in mind the following things:

- Do not translate anything between `{{` and `}}` (`{{example}}`). They are __interpolations__ and will be replaced by localized strings at runtime.
- Do not translate anything between `$t(` and `)` (`$t(example)`). They refer to other localized strings. To find the localized string being referred to, follow the path of the key, which is separated by dots (`.`). For example, the key [`youtu.be./dQw4w9WgXcQ`](https://youtu.be./dQw4w9WgXcQ) refers to:

```JSONc
{
    // ...
    "youtu": {
        // ...
        "be": {
            // ...
            "/dQw4w9WgXcQ": "I am 'youtu.be./dQw4w9WgXcQ'!",
            // ...
        },
        // ...
    },
    // ...
}
```

- The keys under `generic` are vocabularies. They can be referred in translation strings by `$t(generic.key)`. Refer to them as much as possible to standardize translations for vocabularies that appear in different places.
- It is okay to move interpolations and references to other localized strings around to make the translation natural. It is also okay to not use some references used in the original translation. However, it is NOT okay to not use all interpolations.

## Security

We hope that there will never be any security vulnerabilities, but unfortunately it does happen. Please [report](#reporting-a-vulnerability) them!

### Supported versions

| Version | Supported |
|-|-|
| latest | ✅ |
| outdated | ❌ |

### Reporting a vulnerability

Please report a vulerability by opening an new issue. We will get back to you as soon as possible.
