---
"obsidian-terminal": patch
---

Ensure all executable spawn calls use consistent environment variable handling for better PATH inheritance. Fixes external terminal emulator spawning (was completely missing environment), improves system PATH discovery commands (`getconf`, `reg`) which were passed empty environment, and unifies environment handling across all spawn contexts. Renames `sanitizedEnv()` → `sanitizeEnv()`, `applyFixedPtyEnv()` → `applyFixedEnv()`, and `FIXED_PTY_ENV` → `FIXED_ENV` for clarity and consistency since these apply to all spawned processes, not just PTY.
