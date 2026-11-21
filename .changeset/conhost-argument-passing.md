---
"obsidian-terminal": patch
---

Windows: the ConHost backend now starts programs such as cmd, PowerShell and Python with the same arguments as ConPTY. This also applies when a ConPTY profile falls back to ConHost. A cmd profile with `/d /k "prompt CMD$G$S"` now opens with its own prompt instead of an error. Arguments with `^`, a trailing backslash or letters such as `ü` now arrive unchanged. After you press Ctrl+C in a ConHost terminal, exiting the shell no longer stops at "Terminate batch job (Y/N)?". ConHost terminals now also open when the Windows user name contains `^`, `&` or parentheses. (by [@janah01](https://github.com/janah01))
