---
"obsidian-terminal": minor
---

Document and require Python 3.9 or above; use 3.9 for development (macOS ships 3.9 by default).

- Update README badge and install instructions to state Python 3.9 or above.
- Lower minimum Python version in plugin requirements (magic.ts) from 3.10 to 3.9 so
  the settings UI and checks reflect the same minimum.
- Use Python 3.9 for development: `.python-version`, Pyright `pythonVersion` in
  `pyproject.toml`; runtime and `requires-python` remain 3.9 or above.
- Add Python version sync notes in AGENTS.md and comments in pyproject.toml.
