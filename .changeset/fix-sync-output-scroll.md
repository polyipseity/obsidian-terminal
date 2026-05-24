---
"obsidian-terminal": patch
---

Fix scroll viewport reset during AI coding agent streaming output. Fixes [GH#70](https://github.com/polyipseity/obsidian-terminal/issues/70). (Hopefully?)

Adds `SynchronizedOutputScrollAddon` to address the scroll yank caused by AI
coding agents (pi, Claude Code) that use DEC 2026 synchronized output blocks
with `\x1b[2J` (clear-screen) inside each redraw frame.

xterm.js 6.x buffers row renders during a synchronized output block but does
not guard `ydisp`. When the terminal buffer is full and the user is scrolled
up, `Buffer.scroll()` decrements `ydisp` on every scroll call during content
writes — the render at block-end sees this drifted value and paints "topmost
content" for one frame (scroll yank).

The addon saves `viewportY` and `baseY` at block entry (`\x1b[?2026h`) and
restores the equivalent position at block exit (`\x1b[?2026l`) via
`queueMicrotask`. Microtasks run after all synchronous processing in the
current task but before the next animation frame, so the ydisp correction
lands before xterm's buffered render fires and no visible flash occurs.

Workaround for xterm.js [#5801](https://github.com/xtermjs/xterm.js/issues/5801)
(partially addressed in xterm.js [#5770](https://github.com/xtermjs/xterm.js/pull/5770)
targeting 7.x, not yet available in the 6.x release line used by this plugin).
