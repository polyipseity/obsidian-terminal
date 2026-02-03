# Commit Message Convention

This project enforces Conventional Commits for all commits. Your commit message **must** follow this format:

```text
type(scope): short summary

Optional body (wrap at 100 chars, hard wrap required)

Optional footer (BREAKING CHANGE, Refs, etc)
```

## Types

- feat:     A new feature
- fix:      A bug fix
- chore:    Maintenance, build, or tooling change
- docs:     Documentation only
- refactor: Code change that neither fixes a bug nor adds a feature
- test:     Adding or fixing tests
- style:    Formatting, missing semi colons, etc
- perf:     Performance improvement

## Scope

- Use the affected area, e.g. `settings`, `build`, `deps`, `dependabot`, etc.
- Omit if not applicable.

## Examples

```text
fix(dependabot): split update groups for github-actions and npm

- Change dependabot group name from 'all-dependencies' to 'github-actions'.
- Change dependabot group name from 'all-dependencies' to 'npm'.

Refs: dependabot config improvement
```

## Linting

- All commit messages are checked by `commitlint` and `husky`.
- **Header must be ≤ 100 characters.**
- **Body lines must be hard-wrapped at 100 characters or less.**
- All agents and contributors must comply; see `AGENTS.md` for enforcement policy.
- Example (compliant):

  ```text
  refactor(eslint): remove @eslint/compat, eslintrc, js; update Prettier rules
  
  - Removed @eslint/compat, @eslint/eslintrc, @eslint/js from config and lockfiles
  - Updated Prettier to v3 and adjusted markdownlint config for new plugin
  - Cleaned up ESLint overrides and Svelte linting comments
  
  Refs: lint config modernization
  ```

- See `.commitlintrc.mjs` for rules.
- See `AGENTS.md` for agent compliance requirements.

## References

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- [commitlint rules](https://commitlint.js.org/#/reference-rules)
