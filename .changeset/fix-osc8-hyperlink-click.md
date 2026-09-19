---
"obsidian-terminal": patch
---

Fix clicking HTTP(S) OSC 8 hyperlinks in integrated terminals, which failed with `Opening link blocked as opener could not be cleared`. Terminals now use a default link handler that opens these links through Obsidian. ([GH#187](https://github.com/polyipseity/obsidian-terminal/pull/187) by [@GerbenJavado](https://github.com/GerbenJavado))
