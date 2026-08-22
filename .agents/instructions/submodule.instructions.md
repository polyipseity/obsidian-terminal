---
description: "Use when working in the obsidian-plugin-template repo and dealing with the vendored obsidian-plugin-library git submodule. Prevents confusing the submodule at vendor/obsidian-plugin-library with the sibling checkout at ../obsidian-plugin-library."
name: "Vendor Submodule Boundary"
applyTo: "**/*"
alwaysApply: false
---

# Vendor submodule boundary

The template vendors `@polyipseity/obsidian-plugin-library` as a git **submodule** at `vendor/obsidian-plugin-library/` (declared in `.gitmodules`, url `../obsidian-plugin-library.git`). The same project is also checked out as a **sibling** directory `../obsidian-plugin-library/` (i.e. `<monorepo>/obsidian-monorepo/obsidian-plugin-library`) in the monorepo. They are **independent git repos** with the same `origin` remote but **different histories**.

## The trap

Both repos share the same `origin` remote and the same project name. Path-based reasoning (`../obsidian-plugin-library`) is the trap: it points at the sibling, not the submodule. The agent has repeatedly committed to the sibling when told to commit to "the vendor submodule".

## The disambiguator

Before any git write (`git add` / `git commit` / `git push`) in or near this library, verify the git toplevel:

```sh
git -C vendor/obsidian-plugin-library rev-parse --show-toplevel
```

- Must end in `vendor/obsidian-plugin-library` → this is the **submodule** (the commit target).
- Ends in `obsidian-monorepo/obsidian-plugin-library` → this is the **sibling**; do NOT write here unless the user explicitly names that path.

## Rules

- When asked to commit to "the vendor submodule" / "the submodule", the target is `vendor/obsidian-plugin-library` only.
- Never run git write operations in `../obsidian-plugin-library` unless the user explicitly names that path.
- Commits inside the submodule are separate from the template repo and from the sibling; do not push without direction.
- This instruction is about *identifying the correct repo*. It does not relax the absolute prohibition in `core-behavior.instructions.md` against modifying submodules without explicit permission — that rule still applies.
