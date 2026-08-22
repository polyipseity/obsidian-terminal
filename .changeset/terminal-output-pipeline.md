---
"obsidian-terminal": patch
---

Renderer work and memory are bounded on every platform. Writes are sliced to 8 KiB, because one `Terminal.write` chunk is one uninterruptible xterm parse task; output pauses above 128 KiB of unparsed data and resumes below 32 KiB. ConPTY resize repaints pass unsliced for 0.5 s so each viewport frame paints in one task. Every backend applies resizes on one 0.1 s throttle (Windows had 0.5 s), the xterm resize lands before the backend resize, terminals spawn at the fitted pane size, and closing a terminal waits for the pseudoterminal to exit.
