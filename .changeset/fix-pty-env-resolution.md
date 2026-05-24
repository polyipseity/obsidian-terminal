---
"obsidian-terminal": patch
---

Resolve system PATH and sanitize inherited environment variables for embedded terminals. Fixes missing user-installed tools (in `/usr/local/bin`, `/opt/homebrew/bin`, Windows user Python, etc.) that fail with "command not found" inside the integrated terminal when Obsidian is launched via Finder, Start Menu, or desktop launcher. Also prevents terminal misdetection by tools like Claude Code that triggered scroll-to-top issues during streaming. ([#144](https://github.com/polyipseity/obsidian-terminal/pull/144) by [@ahmadelafify](https://github.com/ahmadelafify))

On first PTY spawn, queries the canonical system PATH from the OS (`/usr/libexec/path_helper` on macOS, `/etc/environment` with `getconf` fallback on Linux, registry `HKLM`+`HKCU` on Windows) and merges missing entries into the PTY environment. Strips parent-app variables (`TMUX`, `STY`, `TERM_PROGRAM`, `VSCODE_*`, `ZED_*`) that cause misdetection, and sets `TERM_PROGRAM=obsidian-terminal` on all spawn contexts (Unix PTY, Windows shell, Windows resizer).
