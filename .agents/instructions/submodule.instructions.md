---
description: "Use when working in the obsidian-plugin-template repo and dealing with the vendored obsidian-plugin-library git submodule. Prevents confusing the submodule at vendor/obsidian-plugin-library with the sibling checkout at ../obsidian-plugin-library."
name: "Vendor Submodule Boundary"
applyTo: "**/*"
alwaysApply: false
---

# Vendor submodule boundary

The template vendors `@polyipseity/obsidian-plugin-library` as a git **submodule** at `vendor/obsidian-plugin-library/` (declared in `.gitmodules`, url `../obsidian-plugin-library.git`). The same project is also checked out as a **sibling** directory `../obsidian-plugin-library/` (i.e. `<monorepo>/obsidian-monorepo/obsidian-plugin-library`) in the monorepo. They are **independent git repos** with the same `origin` remote but **different histories**.

## HARD PROHIBITION

**Committing to the sibling `../obsidian-plugin-library` is a HARD FAILURE, not a
mistake to be corrected after the fact.** The agent has repeatedly done exactly
this. It must never happen again. If the disambiguator below shows the sibling,
abort the write immediately and re-run from the submodule path — do not "fix it
up" by committing to the sibling.

## The trap

Both repos share the same `origin` remote and the same project name. Path-based reasoning (`../obsidian-plugin-library`) is the trap: it points at the sibling, not the submodule. The agent has repeatedly committed to the sibling when told to commit to "the vendor submodule".

## The disambiguator (MANDATORY before EVERY git write)

Run this and confirm the output ends in `vendor/obsidian-plugin-library` BEFORE
every `git add` / `git commit` / `git push` in or near this library — not just the
first one:

```sh
git -C vendor/obsidian-plugin-library rev-parse --show-toplevel
```

- Must end in `vendor/obsidian-plugin-library` → this is the **submodule** (the commit target).
- Ends in `obsidian-monorepo/obsidian-plugin-library` → this is the **sibling**; **STOP**. Do NOT write here unless the user explicitly names that path.

## Rules

- When asked to commit to "the vendor submodule" / "the submodule", the target is `vendor/obsidian-plugin-library` only.
- Never run git write operations in `../obsidian-plugin-library` unless the user explicitly names that path.
- The disambiguator is MANDATORY before every git write; never assume the target from the working directory or a prior check.
- If in doubt which repo is the target, STOP and ask — never assume the sibling is correct (fail closed).
- Commits inside the submodule are separate from the template repo and from the sibling; do not push without direction.
- This instruction is about *identifying the correct repo*. It does not relax the absolute prohibition in `core-behavior.instructions.md` against modifying submodules without explicit permission — that rule still applies.
