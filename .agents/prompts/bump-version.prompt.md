---
name: bump-version
description: Bump the project version (major|minor|patch), run any version/regeneration script, and create a release commit and tag.
argument-hint: Required `bump=major|minor|patch`. Optional `commitNow=no` to skip committing and tagging.
agent: agent
---

# Bump Version and Commit

**Never ask for confirmation or clarification. Always proceed automatically using best-effort defaults and available context.**

## Intent

Given a single required input `${input:bump}` indicating whether to bump `major`, `minor`, or `patch`, update the repository version (typically `package.json`), run any project-provided version/regeneration script (if present), stage the changed files, and create a commit and annotated tag for the new version. If `${input:commitNow}` is `no`, perform all local updates and present the exact commands that would be run to commit and tag, but do not create the commit or tag.

## Workflow

1. **Validate input**
   - Ensure `${input:bump}` is one of `major`, `minor`, or `patch`. If not provided or invalid, fail with a short error message explaining the required values.

2. **Detect current version**
   - Print the current version from `package.json`, for example:

     ```shell
     node -e "console.log(require('./package.json').version)"
     ```

   - Report the current version in the output.

   - At the same time, determine a few npm-related Git settings that will affect the bump:
     1. Read `tag-version-prefix`/`tag-version-suffix` as described earlier. A robust implementation should check for their presence in configuration files (such as `.npmrc`) and treat an absent key as unspecified (default prefix "v"), while honouring an explicitly empty setting. You may also run `npm config get tag-version-prefix`/`tag-version-suffix` to see what npm would choose, but remember that those commands always emit a value (they default to "v" when no configuration exists), so the real decision must be based on whether the key is present at all versus present with an empty string.
     2. Check the `sign-git-tag` and optionally `sign-git-commit` npm config values (`npm config get sign-git-tag`). If `sign-git-tag` is true, record that tags should be created with `-s` to produce a GPG/SSH signature. (Commit signing is controlled by Git configuration and the commit snippet below may pass `-S` if desired.)
     3. You may still query `npm config get` for each value, but be aware that npm returns defaults for missing keys; preserve the distinction between unknown and explicitly empty as noted above.
     4. Save all these resolved settings (prefix, suffix, signTag boolean, etc.) for use when constructing commit and tag commands.

3. **Bump `package.json` version**
   - Prefer using the repository's package manager to bump the version without creating a git tag. Detect lockfiles or common tools and prefer them in this order: `pnpm` (pnpm-lock.yaml), `yarn` (yarn.lock), then `npm` (package-lock.json). Examples:

     - npm:

       ```shell
       npm --no-git-tag-version version ${input:bump}
       ```

     - pnpm:

       ```shell
       pnpm version --no-git-tag-version ${input:bump}
       ```

     - yarn (classic).

   - If the package manager command is not applicable or fails, fall back to updating `package.json` programmatically and writing the file.

4. **Run project version/regeneration script (if present)**
   - Detect and run a version or regeneration step if the repository provides one, for example:

     - If `package.json` includes a `version` script: `npm run version` (or the equivalent using pnpm/yarn)
     - If `scripts/version.mjs` exists: `node scripts/version.mjs`

   - The goal is to update any generated manifests/version maps the project uses. If no such script exists, skip this step.

5. **Identify and stage changed files**
   - Discover exactly which files changed as a result of the bump (e.g., `package.json`, lockfiles, generated manifests, version maps) using git status or diff, then stage only those files. Example sequence (run in a single shell):

     ```shell
     # show changed files (porcelain) and stage them explicitly
     git status --porcelain
     git add <file1> <file2> ...
     ```

   - Do not run a broad `git add .` or add unrelated files.

6. **Compose commit message**
   - Use Conventional Commit style. Example message:

     Subject: chore(release): vX.Y.Z

     Body: Short justification or notes (wrap lines to 72 chars).

     Footer: Include `${input:extra}` if provided and any relevant refs.

7. **Create the commit and tag**
   - If `${input:commitNow}` is `no`, skip committing and tagging and only present the commands that would be run.

   - Otherwise, create the commit and an annotated tag. Before constructing the tag name, ensure you've already read the repository's npm configuration (from `.npmrc` or via `npm config get …`) and stored the `tag-version-prefix`/`tag-version-suffix` values. Use that information here when composing the tag string. Remember that an **absent key** means fallback to the default `"v"` prefix, whereas an **explicitly provided empty value** (even if `npm config get` returns `"v"` due to npm’s default) should be treated as the empty string and used accordingly.
   - When preparing the Git commands, also consult the previously recorded `sign-git-tag` (and optionally `sign-git-commit`) flag. If tag signing is requested, include `-s` in the `git tag` invocation; the commit command may include `-S` or rely on the user's global Git signing settings. Signing is preferred when configured, matching the behaviour of npm's `sign-git-tag=true`.

   - Use shell-safe here-doc formats for both shells when executing the commit and tag command:

     - PowerShell (Windows):

       ```powershell
       (@'
       chore(release): ${TAG_PREFIX}X.Y.Z${TAG_SUFFIX}

       <optional body wrapped to 72 chars>
       '@ | git commit --file=- ${SIGN_FLAG}) ; git rev-parse HEAD
       git tag -a ${TAG_SIGN_FLAG}${TAG_PREFIX}X.Y.Z${TAG_SUFFIX} -m "${TAG_PREFIX}X.Y.Z${TAG_SUFFIX}"
       ```

     - Bash/zsh (Linux/macOS):

       ```bash
       (git commit --file - <<'MSG'
       chore(release): ${TAG_PREFIX}X.Y.Z${TAG_SUFFIX}

       <optional body wrapped to 72 chars>
       MSG
       )${SIGN_FLAG:+ && git rev-parse HEAD}
       git tag -a ${TAG_SIGN_FLAG}${TAG_PREFIX}X.Y.Z${TAG_SUFFIX} -m "${TAG_PREFIX}X.Y.Z${TAG_SUFFIX}"
       ```

   - If tagging fails, report the error and do not remove the commit.

8. **Output**
   - 1–2 line summary: previous version → new version, staged files.
   - A `Commit message` block showing the exact message used.
   - If commit/tag ran: `Commit result` with exit status and new commit SHA and tag name.
   - Short justification why this bump type was chosen.

## Rules

- Never ask for confirmation or clarification. Proceed automatically using best-effort defaults and available context.
- Require `${input:bump}` to be explicitly provided and valid; do not guess which component to bump.
- Only stage and commit files that are directly affected by the version bump or by the project's version/regeneration script.
- Prefer package-manager-native version commands (`npm`, `pnpm`, `yarn`) but gracefully fall back to programmatic updates if needed.
- If any command fails, report the error, show commands that were successfully run, and stop further destructive steps.

## Inputs

- `${input:bump}` — required; one of `major`, `minor`, or `patch`.
- `${input:commitNow}` — optional; set to `no` to skip committing/tagging (default is to commit and tag).
- `${input:extra}` — optional extra footer text to append to the commit message.

End of prompt.
