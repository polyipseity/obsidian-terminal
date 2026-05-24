---
"obsidian-terminal": patch
---

Fix scroll viewport reset during AI coding agent streaming output. Fixes [GH#70](https://github.com/polyipseity/obsidian-terminal/issues/70). (Hopefully?)

Adds `SynchronizedOutputScrollAddon` to preserve `viewportY` across DEC 2026
synchronized output blocks (`\x1b[?2026h`/`\x1b[?2026l`). AI coding agents
(pi, Claude Code) use these blocks with `\x1b[2J` (clear-screen) inside, which
causes xterm.js to reset the viewport on every redraw frame — producing visible
scrollbar flicker and unexpected scroll-position jumps during streaming output.

The addon snapshots `viewportY` and `baseY` at block entry and restores the
equivalent position on exit via `setTimeout(0)`, adjusting for `baseY` growth
caused by ED2 pushing screen rows into scrollback. Workaround for xterm.js
[#5801](https://github.com/xtermjs/xterm.js/issues/5801) (partially addressed
in xterm.js [#5770](https://github.com/xtermjs/xterm.js/pull/5770) targeting
7.x, not yet available in the 6.x release line used by this plugin).
