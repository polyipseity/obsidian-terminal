# Terminal for Obsidian ![release](https://img.shields.io/github/v/release/polyipseity/obsidian-terminal) ![Obsidian downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%238b6cef&label=downloads&query=%24%5B%22terminal%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)

Integrate consoles, shells, and terminals inside [Obsidian](https://obsidian.md/).

__[Features](#features) · [Installation](#installation) · [Usage](#usage) · [Contributing](#contributing) · [Todos](#todos)__

![Trailer](assets/trailer.png)

For first time users, read the [installation](#installation) section first!

This file is automatically opened on first install. You can reopen it in settings or command palette.

- Repository: https://github.com/polyipseity/obsidian-terminal
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Community plugin: https://obsidian.md/plugins?id=terminal

## Features

- Start external terminals from Obsidian.
- Integrate terminals into Obsidian.
- Supports multiple terminal profiles.
- Has builtin hotkeys.
- Automatically save and restore integrated terminal history.
- Find in terminal.
- Save terminal history as file.

## Installation

1. Install plugin.
	- Community plugins
		1. [Install](https://obsidian.md/plugins?id=terminal) from community plugins directly.
	- Manual
		1. Create directory `terminal` under `.obsidian/plugins` of your vault.
		2. Place `manifest.json`, `main.js`, and `styles.css` from the [latest release](https://github.com/polyipseity/obsidian-terminal/releases) into the directory.
2. (optional for Windows, recommended) Install Python and dependencies.
	1. [Download](https://www.python.org/downloads/) and install Python 3.10/+.
	2. (Windows only) Run `pip3 install psutil pywinctl`.
	3. Configure Python executable in plugin settings.
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
		1. Press `Ctrl+P` or click on the `Open command palette` ribbon next to the left window border.
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
		- (4) Use hotkeys

### Hotkeys

__Terminal tab is focused__
- Focus terminal: `Ctrl`+`Shift`+`` ` ``, `Command`+`` ` `` (macOS)
- Inherit from app hotkeys

__Terminal is focused__
- Focus terminal tab/Unfocus terminal: `Ctrl`+`Shift`+`` ` ``, `Command`+`` ` `` (macOS)
- Clear terminal: `Ctrl`+`Shift`+`K`, `Command`+`K` (macOS)
- Find in terminal: `Ctrl`+`Shift`+`F`, `Command`+`F` (macOS)

### Profiles

This plugin comes with several profile presets that you can reference.

When setting up a terminal profile, you need to distinguish between shells and terminal emulators. (Search online if needed.) Generally, integrated profiles only work with shells while external ones only work with terminal emulators.

#### Examples

__Shells__
- Bash: `bash`
- Bourne shell: `sh`
- Command Prompt: `cmd`
- Dash: `dash`
- PowerShell: `pwsh`
- Windows Subsystem for Linux: `wsl -d <distribution name>`
- Z shell: `zsh`

__Terminal emulators__
- Command Prompt: `cmd`
- macOS Terminal: `/System/Applications/Utilities/Terminal.app/Contents/macOS/Terminal $PWD`
- xterm: `xterm`

## Contributing

Contributions are welcome via pull requests!

### Translating

Translation files are under [`assets/locales/`](assets/locales/). Each locale has its own directory named with its corresponding __[IETF language tag](https://wikipedia.org/wiki/IETF_language_tag)__.

To contribute translation for an existing locale, modify the files in the corresponding directory.

For a new locale, create a new directory named with its language tag and copy [`assets/locales/en/translation.json`](assets/locales/en/translation.json) into it. Then, add an entry to [`assets/locales/en/language.json`](assets/locales/en/language.json) in this format:
```JSON
{
	// ...
	"en": "English",
	"(your-language-tag)": "(Native name of your language)",
	"uwu": "Uwu",
	// ...
}
```
Sort the list of languages by the alphabetical order of their language tags. Then modify the files in the new directory.

When translating, keep in mind the following things:
- Do not translate anything between `{{` and `}}` (`{{example}}`). They are __interpolations__ and will be replaced by localized strings at runtime.
- Do not translate anything between `$t(` and `)` (`$t(example)`). They refer to other localized strings. To find the localized string being referred to, follow the path of the key. For example, the key `a.b.c` refers to:
```JSON
{
	// ...
	"a": {
		// ...
		"b": {
			// ...
			"c": "I am 'a.b.c'!",
			// ...
		},
		// ...
	},
	// ...
}
```
- The keys under `generic` are vocabularies. They can be referred in translation strings by `$t(generic.key)`. Refer to them as much as possible to standardize translations for vocabularies that appear in different places.
- It is okay to move interpolations and references to other localized strings around to make the translation natural. It is also okay to not use some references used in the original translation. However, it is NOT okay to not use all interpolations.

## Todos

- Add setting for successful exit codes.
- Add terminal restoring options.
- Color console log.
- Add terminal style options.
- Check whether the terminal looks okay in light theme.
- Add connecting to remote shells. It should also be available on mobile.
