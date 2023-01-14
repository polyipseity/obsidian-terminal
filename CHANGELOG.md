# Changelog for Terminal

Versions are ordered by recency.

- Read me: [README.md](README.md)

## 2.8.0

__Features__
- Add 2 new plugin settings.
  - Hide status bar (`86c6602bd2b6b2e93f13e182ae11daa413a28cf3`)
  - Enable Windows 'conhost.exe' workaround (`e2710eca0e38570e812cd7beb467b71223a4696c`)

__Improvements__
- Log error and notify user if terminal resizer fails to start. (`5be0367243ad9a4655f9b09575d6a17ee317a707`)

__Fixes__
- Fix terminal not starting if terminal resizer fails to start. (`459ac226e08bc8898885731a41de6406af10c322`)
- Fix text escaping unnecessarily in notice messages. (`0dc8152517d29f896021beeafd355c4f2b8d2907`)

__Full changelog__: [`2.7.0...2.8.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.7.0...2.8.0)

## 2.7.0 🥳

The plugin has just been [accepted](https://github.com/obsidianmd/obsidian-releases/pull/1472) into community plugins! 🥳

You can now get the plugin here instead: https://obsidian.md/plugins?id=terminal

No, there is no celebration for this. 😞

__Features__
- Add setting to configure or disable Python terminal resizer.

__Fixes__
- Fix integrated terminal not resizing when the terminal is not focused.
- Fix integrated terminal window not hidden when Python terminal resizer is unavailable.
- Fix potential issues with `cmd.exe` argument escaping.
- Housekeeping.

__Others__
- The view type of terminal is changed from `terminal:terminal-view` to `terminal:terminal`. Existing views will break unless you know how to modify `.obsidian/workspace.json` to fix it.
- Improve `README.md` significantly.
- Create `CHANGELOG.md` (the file you are viewing now).

__Full changelog__: [`2.6.1...2.7.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.6.1...2.7.0)

## 2.6.1

- Fix 2 bugs.
- Housekeeping.

**Full Changelog**: [`2.6.0...2.6.1`](https://github.com/polyipseity/obsidian-terminal/compare/2.6.0...2.6.1)

## 2.6.0

- Add the `Save as HTML` functioin to the tab context menu.

**Full Changelog**: [`2.5.1...2.6.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.5.1...2.6.0)

## 2.5.1

- No user-facing changes.
- Fix tiny memory leak sources.
- Less errors in the developer console.
- Housekeeping.

**Full Changelog**: [`2.5.0...2.5.1`](https://github.com/polyipseity/obsidian-terminal/compare/2.5.0...2.5.1)

## 2.5.0

- Implement terminal history restoration.
- Change default Linux terminal executable to ``xterm-256color``.
- Housekeeping.

**Full Changelog**: [`2.4.2...2.5.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.4.2...2.5.0)

## 2.4.2

- Change icons of reset buttons to icons that represent the corresponding settings.
- Improve a setting translation.
- Housekeeping.

**Full Changelog**: [`2.4.1...2.4.2`](https://github.com/polyipseity/obsidian-terminal/compare/2.4.1...2.4.2)

## 2.4.1

- No user-facing changes.
- Various minor code improvements.

**Full Changelog**: [`2.4.0...2.4.1`](https://github.com/polyipseity/obsidian-terminal/compare/2.4.0...2.4.1)

## 2.4.0

- Add language settings.
  - Translated text are dynamically updated when language is changed.
- Add support for 2 locales: `简体中文` (`zh-Hans`), `繁體中文` (`zh-Hant`)
- Fix various bugs.
- Improve code.

**Full Changelog**: [`2.3.3...2.4.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.3.3...2.4.0)

## 2.3.3

- Fix terminal persistence across Obsidian restarts.

**Full Changelog**: [`2.3.2...2.3.3`](https://github.com/polyipseity/obsidian-terminal/compare/2.3.2...2.3.3)

## 2.3.2

- No user-facing changes.
- Improve code.

**Full Changelog**: [`2.3.1...2.3.2`](https://github.com/polyipseity/obsidian-terminal/compare/2.3.1...2.3.2)

## 2.3.1

- Configure esbuild to build an even smaller `main.js`.
- Fix status bar hiding and error ignoring.
- Improve code.

**Full Changelog**: [`2.3.0...2.3.1`](https://github.com/polyipseity/obsidian-terminal/compare/2.3.0...2.3.1)

## 2.3.0

- Hide status bar when the terminal is focused to avoid obstruction.
- Improve terminal resizing.
- Change internal structure of settings data. (You may need to reset or delete settings.)
- Potentially reduce plugin loading time.
- Code improvement.

**Full Changelog**: [`2.2.0...2.3.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.2.0...2.3.0)

## 2.2.0

- Commands now work outside of editing mode (i.e. reading mode).
- Improve reporting exit code of terminals.
- Fix web links in terminal view not opening.
- The backing terminal is automatically resized with Python 3.
  - Makes the terminal more usable generally, especially TUIs.
  - Tested on Windows only.
  - Python 3 is only required for this enhancement, otherwise it remains optional.
  - Run `pip install psutil pywinctl` before using.
- Code improvement.

**Full Changelog**: [`2.1.0...2.2.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.1.0...2.2.0)

## 2.1.0

- Add `Notice timeout` setting.
- Various minor quality-of-life changes.
- Implement internationalization and localization.
- Fix various bugs.
- Optimize code.

**Full Changelog**: [`2.0.0...2.1.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.0.0...2.1.0)

## 2.0.0

- Add functionality to embed terminals inside Obsidian.

**Full Changelog**: [`1.0.0...2.0.0`](https://github.com/polyipseity/obsidian-terminal/compare/1.0.0...2.0.0)

## 1.0.0

Initial release.

**Full Changelog**: [`0.0.1...1.0.0`](https://github.com/polyipseity/obsidian-terminal/compare/0.0.1...1.0.0)
