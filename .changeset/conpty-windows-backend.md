---
"obsidian-terminal": major
---

Use ConPTY by default for Windows integrated terminals, improving full-screen application drawing and resizing. ConPTY requires Python 3.9 or newer and no pip packages; installation examples recommend Python 3.14.

**Breaking:** remove the "Shell pipes" backend and "Use Windows 'conhost.exe'" setting. Existing Windows profiles migrate to ConPTY once on upgrade when Python is available. The new **Windows terminal backend** profile setting allows switching to ConHost; an explicit ConHost choice is preserved.

- Add a Windows **Python executable** setting with automatic detection, interpreter status, and a download link when Python is missing. Profiles inherit it unless they specify their own interpreter. Resolved paths stay out of synced settings. Missing Python falls back to ConHost without its resizer; detecting Python on recheck or reload restores automatically demoted profiles to ConPTY.
- Add **Prewarm ConPTY terminal host**, enabled by default on Windows, to prepare a spare host and avoid Python startup time when opening a terminal.
- Guide users with missing ConHost resizer packages to ConPTY or a copied installation command explicitly intended for PowerShell, with literal quoting for interpreter paths.
- Preserve bare batch launchers without shadowing native executables, and share concurrent ConPTY host-file repairs.
- Resolve native Windows system programs through Sysnative when the ConPTY host uses 32-bit Python, and refresh the registry PATH when rechecking Python after installation.
- Keep terminals responsive under heavy output on every platform using sliced writes and backpressure. Reduce resize throttling from 0.5 to 0.1 seconds and start terminals at the fitted pane size.
- Suppress exit notifications for intentional closes and restarts while retaining notifications for spontaneous exits.
- Detach closing terminals immediately and dispose their UI before waiting for process exit, including when a child ignores termination.

Fixes [GH#104](https://github.com/polyipseity/obsidian-terminal/issues/104); addresses [GH#77](https://github.com/polyipseity/obsidian-terminal/issues/77), [GH#79](https://github.com/polyipseity/obsidian-terminal/issues/79), [GH#115](https://github.com/polyipseity/obsidian-terminal/issues/115), [GH#142](https://github.com/polyipseity/obsidian-terminal/issues/142), [GH#145](https://github.com/polyipseity/obsidian-terminal/issues/145), [GH#153](https://github.com/polyipseity/obsidian-terminal/issues/153), and [GH#168](https://github.com/polyipseity/obsidian-terminal/issues/168). ([GH#183](https://github.com/polyipseity/obsidian-terminal/pull/183) by [@janah01](https://github.com/janah01))
