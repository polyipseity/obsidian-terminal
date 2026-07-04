---
description: Use when referencing GitHub issues or pull requests in commit messages, changesets, documentation, or code comments.
name: GitHub References
applyTo: "**/*"
---

# GitHub References

This project uses the `GH#N` prefix (not bare `#N`) to reference GitHub issues and pull requests. This avoids ambiguity between GitHub issues and other number-based references.

## Commit message references

When a commit relates to one or more GitHub issues or pull requests, include a keyword reference in the commit body or footer:

| Keyword | When to use |
| --- | --- |
| [Fixes GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N) | The commit fixes a bug or resolves an issue |
| [Closes GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N) | The commit closes a feature request or task |
| [Resolves GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N) | The commit resolves a discussion or inquiry |
| [Helps with GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N) | Partial progress toward an issue (not fully resolved) |
| [Partially fixes GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N) | Partial fix for a bug |
| [Address GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N) | Commit partially addresses an issue |
| [See GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N) | Reference for context or related work |

Reference multiple issues with `and` (e.g., Closes [GH#4](https://github.com/polyipseity/obsidian-terminal/issues/4) and [GH#6](https://github.com/polyipseity/obsidian-terminal/issues/6)).

Example:

```text
fix(pty): handle EOF on pipe close

Prevents orphaned child processes when the host disconnects.

Closes [GH#162](https://github.com/polyipseity/obsidian-terminal/issues/162).
```

## Changeset references

When adding a changeset for a pull request, end the changeset body with a PR attribution link:

```markdown
---
"example": patch
---

Description of change. ([GH#N](https://github.com/polyipseity/obsidian-terminal/pull/N) by [@user](https://github.com/user))
```

If the changeset additionally fixes an issue, include an issue link before the PR attribution:

```markdown
Description of change. Fixes [GH#N](https://github.com/polyipseity/obsidian-terminal/issues/N). ([GH#N](https://github.com/polyipseity/obsidian-terminal/pull/N) by [@user](https://github.com/user))
```

Always use the `GH#N` shorthand in link text (e.g., `[GH#N](...)`), not bare `#N`. See `README.md` for the canonical changeset documentation.

## Documentation references

In prose documentation (changelogs, README, etc.), use the same `GH#N` prefix:

```markdown
Fixes [GH#93](https://github.com/polyipseity/obsidian-terminal/issues/93).
See [GH#108](https://github.com/polyipseity/obsidian-terminal/pull/108).
...theme or accent color changes ([GH#124](https://github.com/polyipseity/obsidian-terminal/issues/124), [GH#135](https://github.com/polyipseity/obsidian-terminal/issues/135))...
```
