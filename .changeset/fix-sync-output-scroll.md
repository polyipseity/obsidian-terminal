---
"obsidian-terminal": patch
---

Fix scroll viewport reset and screen flicker during AI coding agent streaming output. Fixes [GH#70](https://github.com/polyipseity/obsidian-terminal/issues/70). (Hopefully?)

Adds `SynchronizedOutputScrollAddon` to address two visible artefacts caused
by AI coding agents (pi, Claude Code) that use DEC 2026 synchronized output
blocks with `\x1b[2J` (clear-screen) inside each redraw frame:

1. **Scroll yank:** xterm.js resets `viewportY` on every `\x1b[2J`, yanking
   the viewport to the bottom unexpectedly. Fixed by snapshotting `viewportY`
   and `baseY` at block entry (`\x1b[?2026h`) and restoring the equivalent
   position on exit (`\x1b[?2026l`) via `setTimeout(0)`, adjusting for `baseY`
   growth caused by ED2 pushing screen rows into scrollback.

2. **Screen flicker:** xterm.js 6.x has no built-in rendering suppression for
   sync blocks; the RAF loop fires on every `\x1b[2J`, painting a blank canvas
   before the redrawn content arrives. Fixed by registering a CSI J handler
   that returns `true` (suppress) for ED2 inside sync blocks so xterm skips
   the blank-screen paint. AI agents always follow ED2 with a full redraw, so
   the suppression is transparent to the user.

Workaround for xterm.js [#5801](https://github.com/xtermjs/xterm.js/issues/5801)
(partially addressed in xterm.js [#5770](https://github.com/xtermjs/xterm.js/pull/5770)
targeting 7.x, not yet available in the 6.x release line used by this plugin).
