# Terminal for Obsidian

![Trailer](assets/trailer.png)

Open terminals in [Obsidian](https://obsidian.md/) directly.

- Repository: https://github.com/polyipseity/obsidian-terminal

## Features

- Open external terminals directly from Obsidian.
- Open terminals integrated into the Obsidian workspace.
- Automatically save and restore integrated terminal history across Obsidian restarts.
- Save terminal history as file.

## Usage

Right-click files, folders, or editor tabs to open the context menu, from which you can open an external or integrated terminal. Alternatively, use the command palette (`Ctrl+P`).

## Installation

1. Create directory `terminal` under `.obsidian/plugins` of your vault.
2. Place `manifest.json`, `main.js`, and `styles.css` into the directory.
3. Enable the plugin.
4. (optional, recommended) Install Python and dependencies for properly resized terminals.
	1. [Download](https://www.python.org/downloads/) and install Python 3.
	2. Run `pip install psutil pywinctl`.
	3. Ensure `python` is in your `PATH`.
5. (optional) Configure plugin settings.

## Todos

- Untested on Linux and MacOS.
- Terminal addons are not working yet.
- Connect to remote shells. (could support mobile devices)
