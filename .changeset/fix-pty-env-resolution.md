---
"obsidian-terminal": patch
---

Resolve system PATH and sanitize environment variables for embedded terminals. GUI-launched Obsidian (via Finder, Start Menu, or desktop launcher) inherits a minimal `PATH` missing user-installed tools; this fix queries the canonical system PATH on first use (`/usr/libexec/path_helper` on macOS, `/etc/environment` with `getconf` fallback on Linux, registry `HKLM`+`HKCU` on Windows) and merges any missing entries into the PTY environment. Also strips parent-app variables (`TMUX`, `STY`, `TERM_PROGRAM`, `VSCODE_*`, `ZED_*`) that cause tools like Claude Code to misdetect the terminal and trigger rendering issues, and sets `TERM_PROGRAM=obsidian-terminal` on all spawn paths. ([GH#144](https://github.com/polyipseity/obsidian-terminal/pull/144) by [@ahmadelafify](https://github.com/ahmadelafify))
