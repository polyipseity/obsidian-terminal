---
"obsidian-terminal": minor
---

A spare host pool for the ConPTY backend, controlled by the new **Prewarm ConPTY terminal host** setting (Windows only, default on). Interpreter boot is the dominant ConPTY startup stage, so the host can boot, authenticate, and wait for a `start` operation; one spare per interpreter is kept after each session becomes ready, plus one after layout-ready, and the next open pays only session creation plus the ready handshake. Spares are killed on plugin unload and replaced after a failed session. A spare session resolves the shell through the profile's `PATH` and working directory the same way a cold one does.
