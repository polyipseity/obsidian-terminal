# Changelog for Terminal

Versions are ordered by recency.

- Read me: [README.md](README.md)

## 2.10.0

__Notices__
- Updating the plugin starting from this version to a newer version will no longer close all active terminal views. (Does not include updating from a previous version to this version.)
- Please reset your settings and reconfigure it.
- Linux, macOS: Please specify a terminal emulator (not a shell) for external terminal, and a shell (not a terminal emulator) for internal terminal.
- macOS: This is not necessary if you have only used the release versions. But just in case, you might need to reset settings to apply the external terminal cwd fix.
- macOS: The external terminal cwd fix is implemented by passing `$PWD` as the first argument to the external terminal. This might cause issues with non-default terminals. You may need to edit `executables.darwin.extArgs` in `.obsidian/plugins/terminal/data.json` to remove the first argument. Also see the hint.
- mobile: You can only change settings on mobile for now.
- Hint: There are hidden settings to set the launching arguments in `.obsidian/plugins/terminal/data.json`. Search for `intArgs` and `extArgs`. I still need to figure out how to present the hidden settings in the settings UI well.

__Features__
- Terminal view no longer closes when the underlying process terminates. (`934eb24e2c7106e1122c8c29e4160ca5d55749ef`)
- Add terminal restoration message in the format of ` * Restored history at (time)`. (`5dd1efb5709af6d5f7dae7ee5d4b813fc4156612`)
- Add menu to restart terminal and resizer. Access by right-clicking terminal tab header. (`313b4b8f0c2ec2f71d79fd519925aab71cfff910`)
- Add settings to disable annoying notices. (`602954ee0ee619368ffb770310262656ee1a1551`)
- Add settings to specify external terminal separately. (`a80466f309483f6971c29b85d5825449ab93c448`)

__Fixes__
- Terminal view persists when updating the plugin. (`934eb24e2c7106e1122c8c29e4160ca5d55749ef`)
- Windows: Pressing `Ctrl-C` will no longer close the resizer sometimes. (`fc95167374d3174ce94ce47ecc8bb41709b2c535`)
- Fix "reset all" not resetting all settings. (`133a141e10b09f9bf29c59ed5ffaa6cde5594b72`)
- (See notices) Mobile: Fix plugin not loading. (`3b55de2c48bb5bbcb35f7a4d5a533b58d520670d`..`63c99375fbf29ef9fa6cbf27dd527071987a13fd`)
- (See notices) Linux, macOS: Fix external terminal not opening by separating external and internal terminal executable. (`a80466f309483f6971c29b85d5825449ab93c448`)
- (See notices) macOS: Fix external terminal not starting in the specified cwd. Might not work with non-default terminals. (`0b66970f065160e713067bb930bedf97f7f71793`)

__Internals__
- Housekeeping.
- Refactor terminal files.
- Handle more uncaught errors. Less errors in the developer console!
- Update npm packages. (`02f455b7c8b196116d45d98dd8fe51f750671b59`)
- Improve build scripts. (`02b0174ec8b6252dcd98fbc1925069db41d5ab23`)

__Full changelog__: [`2.9.0...2.10.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.9.0...2.10.0)

## 2.9.0

After lots of hard work, v2.9.0 is finally ready! 😅

__Fixes__
- Fix integrated terminals on Linux and macOS (more generally, Unix). Python 3.10/+ is required but Python packages `psutil` and `pywinctl` are no longer required on Unix platforms. This should address the problem with integrated terminals of [GH#2](https://github.com/polyipseity/obsidian-terminal/issues/2). (`7812e8f148a0f52c2f576dded17266de07e3cebc`..`5dbea610f75dbadce28d54b90c8549fb6c24fc6e`)
- Change default Python executable to `python3` to avoid starting Python 2. (`ba931427b1e5e2dd4a716ff90946e7a855eb5aea`)
- Fix error handling. (`905d52e06eb83c6f915c9bb4fa4fcb2afece7327`..`8ac982e97ab32249135ffe36cc7ffc03548af059`)

__Internals__
- Validate language files. (`e919a7cf4fa165a92dc9c91f40f448ef9ae999c5`..`29fdad08527e7b798277d0aed4b231aedf77105e`)
- Housekeeping.

__Miscellaneous__
- Allow plugin to be enabled on mobile. It does nothing though. (`cb40072e533b1dc20d441485817bced1b49b55ea`..`b400a4412f29fda901e579b7b2968305579ac4f1`)
- Add all languages available in Obsidian (untranslated except for 2). (`29fdad08527e7b798277d0aed4b231aedf77105e`)
- Update translations.
- Update `README.md`.

__Known bugs__
- Opening external terminals is still broken on Linux and macOS.

__Full changelog__: [`2.8.1...2.9.0`](https://github.com/polyipseity/obsidian-terminal/compare/2.8.1...2.9.0)

## 2.8.1

__Fixes__
- Fix failing to load plugin. (`fc07030d02699323f103b9609590ca5f6d6245ef`)
- Housekeeping.

__Full changelog__: [`2.8.0...2.8.1`](https://github.com/polyipseity/obsidian-terminal/compare/2.8.0...2.8.1)

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
