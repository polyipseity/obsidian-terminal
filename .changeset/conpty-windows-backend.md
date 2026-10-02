---
"obsidian-terminal": major
---

Windows integrated terminals now use ConPTY by default. ConPTY needs Python 3.9 or newer and no pip packages.

The "Use Windows conhost.exe" toggle and its pipe mode are removed. Every Windows integrated profile upgraded from 3.27.x now selects ConPTY, whatever the old toggle said; choose **ConHost** in the new **Windows terminal backend** profile setting to keep it. Without a working Python, terminals fall back to ConHost and the profile stays unchanged. An empty profile **Python executable** on Windows now inherits the plugin-level setting and auto-detects, so ConHost profiles left empty to skip the resizer get it whenever a usable Python has the resizer packages. No setting turns the resizer off.

- GUI apps and detached processes started from a ConPTY terminal keep running after the terminal closes.
- Windows-only profiles still on the old `python3` default now inherit the plugin-level Python setting.
- The new Windows **Python executable** setting shows interpreter status and auto-detects: profile interpreter, plugin interpreter, then `python`, `python3`, and `py -3`.
- **Prewarm ConPTY terminal host**, on by default, keeps a spare Python process ready so terminals open faster, once an integrated terminal has worked.
- Automatic Python checks run only bare command names and drive-absolute paths. Settings checks run when a field is committed or with **Check** / **Recheck**, not while typing.
- Python status names an unusable configured interpreter and the working fallback; ConHost fallback notices add install guidance.
- Closing a tab cancels pending ConPTY startup without a fallback shell or error notice, and intentional closes and restarts show no exit notice. The UI is disposed before waiting for process exit, even when a child ignores termination.
- Resize throttling drops from 0.5 to 0.1 seconds, and terminals start at the fitted pane size.

Fixes [GH#104](https://github.com/polyipseity/obsidian-terminal/issues/104); addresses [GH#77](https://github.com/polyipseity/obsidian-terminal/issues/77), [GH#79](https://github.com/polyipseity/obsidian-terminal/issues/79), [GH#115](https://github.com/polyipseity/obsidian-terminal/issues/115), [GH#142](https://github.com/polyipseity/obsidian-terminal/issues/142), [GH#145](https://github.com/polyipseity/obsidian-terminal/issues/145), [GH#153](https://github.com/polyipseity/obsidian-terminal/issues/153), and [GH#168](https://github.com/polyipseity/obsidian-terminal/issues/168). ([GH#183](https://github.com/polyipseity/obsidian-terminal/pull/183) by [@janah01](https://github.com/janah01))
