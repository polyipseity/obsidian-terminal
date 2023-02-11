# Terminal for Obsidian

![Trailer](assets/trailer.png)

Integrate consoles, shells, and terminals inside [Obsidian](https://obsidian.md/).

For first time users, read the [installation](#installation) section first!

- Repository: https://github.com/polyipseity/obsidian-terminal
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Community plugin: https://obsidian.md/plugins?id=terminal

## Features

- Start external terminals from Obsidian.
- Integrate terminals into Obsidian.
- Find in terminal.
- Automatically save and restore integrated terminal history.
- Save terminal history as file.

## Usage

- To start a new external or integrated terminal
	- Context menu
		1. Right-click on files, folders, or tab headers.
		2. Choose the desired terminal action.
	- Command palette
		1. Press `Ctrl+P` or click on the `Open command palette` ribbon next to the left window border.
		2. Choose the desired terminal action.
- To save and restore integrated terminal history
	1. Keep the terminal open when exiting Obsidian.
	2. Terminal history will be restored next time Obsidian is opened.
- Additional actions
	- Includes
		- Find in terminal
		- Restart terminal
		- Save terminal history as file
	- Available by
		- Right-click on terminal tab header

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

## Todos

- Add setting for successful exit codes.
- Add terminal text loading.
- Add terminal duplication.
- Add terminal restoring options.
- Fix key problems (e.g. `Esc` unfocuses the terminal).
- Add terminal style options.
- Check whether the terminal looks okay in light theme.
- Add connecting to remote shells. It should also be available on mobile.
