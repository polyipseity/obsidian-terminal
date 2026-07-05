---
name: code-review
description: Use when reviewing PRs, code changes, or conducting code audits in obsidian-terminal. Covers correctness, type safety, architecture fit, test coverage, localization, and completeness.
---

# Code Review Skill — obsidian-template-plugin

Use this skill to perform structured, thorough code reviews of this repository. Follow the preparation steps, then check each dimension using its checklist.

## Preparation

1. Identify the base and head refs (e.g., `git log --oneline HEAD...main`, or check the PR's base branch).
2. Get a compact diff overview: `git diff <base>..<head> --stat`.
3. Read the full diff: `git diff <base>..<head>`.
4. Identify all changed files and their types (`.ts`, `.json`, `.mjs`, `.md`, etc.).
5. For each changed file, read the full file (not just the diff) to understand context.
6. Read related integration points: e.g., if `src/terminal/view.ts` changed, also read `src/terminal/load.ts` and relevant interfaces.

## Review Dimensions

### Correctness

- [ ] Logic errors: off-by-one, null/undefined dereference, missing early returns.
- [ ] State management: does the change properly read, mutate, and persist state? Are race conditions possible?
- [ ] Async handling: are `await`/`.then()` used correctly? Are promises caught?
- [ ] Edge cases: empty states, boundary values, rapid toggling, concurrent access.
- [ ] Backward compatibility: default values preserve existing behavior. Old saved data still loads correctly.

### Type Safety

- [ ] No `as` casts (check project coding conventions — this repo disallows them).
- [ ] No `any` types. `unknown` used where input is untrusted.
- [ ] Runtime type guards or `.fix()` validators used to narrow `unknown` before use.
- [ ] Public API has explicit return types and parameter types.
- [ ] No deeply inferred anonymous types at package boundaries.

### Architecture Fit

- [ ] Follows existing patterns: `.fix()` for settings validation, `linkSetting`/`resetButton` for UI, `Manager` classes for lifecycle.
- [ ] Uses `SettingsManager` and `LanguageManager` as shown in `src/main.ts`.
- [ ] Localization uses `createI18n(PluginLocales.RESOURCES, ...)` and `language.value.t(...)`.
- [ ] New files follow the `src/` directory layout and naming conventions.
- [ ] No new architecture introduced where an existing pattern would suffice.

### Test Coverage

- [ ] Behavioral changes have tests added (per project convention: "test that fails before implementing the change").
- [ ] Follows **one test file per source file** convention under `tests/`.
- [ ] Unit tests (`*.spec.*`) are fast, hermetic, BDD-style.
- [ ] Integration tests (`*.test.*`) are isolated and documented.
- [ ] Tests use `vi.fn()`, `vi.spyOn()`, `vi.mocked()` per conventions.
- [ ] `vitest run` is used (never watch mode) in automated flows.
- [ ] Locale keys have existence tests if adding user-facing strings.

### Localization

- [ ] New keys added to `assets/locales/en/translation.json` first.
- [ ] `{{...}}` placeholders and `$t(...)` calls kept intact, not translated.
- [ ] Icon key added to `assets/locales/en/asset.json` if a settings icon is needed.
- [ ] Alphabetical ordering maintained in locale JSON files.
- [ ] Sync script run: `node scripts/sync-locale-keys.mjs` to propagate to all locales.
- [ ] Description text is clear about behavior (not just label).
- [ ] Follows `.agents/instructions/localization.instructions.md`.

### Build & Scripts

- [ ] Changes to `scripts/build.mjs` have corresponding tests in `tests/scripts/build.test.mjs`.
- [ ] Changes to `scripts/obsidian-install.mjs` have corresponding tests in `tests/scripts/obsidian-install.test.mjs`.
- [ ] `manifest.json` changes are reflected in `versions.json` if needed.
- [ ] No hardcoded paths or environment-dependent behavior in scripts.

### Documentation

- [ ] Changeset added (`.changeset/`) with correct bump type (major/minor/patch) and PR reference.
- [ ] Changeset follows Conventional Commits style.
- [ ] `AGENTS.md` updated if infra, testing conventions, or agent-visible patterns changed.
- [ ] In-code docs updated if public API changed.
- [ ] Commit message follows Conventional Commits: header ≤72 chars, body wrapped at 100 chars.

### Regression Risk

- [ ] Default values preserve existing behavior (`false`/opt-in for new features).
- [ ] Changes are backward-compatible with saved user data (old `data.json` still loads).
- [ ] Existing tests still pass (run `bun x vitest run`).
- [ ] The change is minimal — no unrelated refactoring or reformatting.

### Completeness

- [ ] All integration points checked: settings-data (interface, DEFAULT, fix), settings UI, view behavior, locale keys, changeset.
- [ ] No TODO comments or placeholder code left in.
- [ ] Every changed file is consistent with the overall feature/change.
- [ ] The diff `--stat` shows all expected files and no unexpected ones.

## Step-by-Step Workflow

1. **Preparation** — check out the branch, read the diff, read changed files in full context.
2. **Architecture check** — does the change follow existing patterns? Identify any new patterns introduced.
3. **Correctness pass** — trace the logical flow: entry point → data flow → output. Check edge cases.
4. **Type safety pass** — scan for `as`, `any`, missing type guards.
5. **Test pass** — verify tests exist and follow conventions. Check the actual test content if present.
6. **Localization pass** — verify locale keys, sync, and ordering.
7. **Documentation pass** — verify changeset, commit messages, AGENTS.md updates.
8. **Regression check** — are defaults safe? Are old behaviors preserved? Do existing tests pass?
9. **Completeness check** — re-read the diff stat and confirm every piece is accounted for.
10. **Report** — produce a structured review with:
    - Overview of the change
    - What's done well
    - Issues found (with severity and file:line references)
    - Concrete fix recommendations
    - Completion checklist (✅/⚠️/❌)

## References

- [TypeScript standards](../../instructions/typescript.instructions.md)
- [Localization rules](../../instructions/localization.instructions.md)
- [Commit message convention](../../instructions/commit-message.instructions.md)
- [Plugin testing skill](../plugin-testing/SKILL.md)
- [Agent quick rules](../../instructions/agents.instructions.md)
- [Workspace quick instructions](../../instructions/workspace.instructions.md)
- Repository [`AGENTS.md`](../../../AGENTS.md)
