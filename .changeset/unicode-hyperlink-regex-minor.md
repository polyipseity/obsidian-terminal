---
"obsidian-terminal": minor
---

Override WebLinksAddon's default regex so `obsidian://` URIs (in addition to
`https?://`) are recognized as clickable links in the terminal view.

The addon's built-in pattern from v0.12.0 only covered http(s), which meant
custom-protocol links were ignored. This wider regex keeps existing behavior
for standard URLs while fixing #88. ([GH#114](https://github.com/polyipseity/obsidian-terminal/pull/114) by [@joe-king-sh](https://github.com/joe-king-sh))
