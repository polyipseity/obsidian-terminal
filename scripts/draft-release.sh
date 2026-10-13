#!/usr/bin/env bash
# The "Draft release" step of .github/workflows/release.yml. It is a file so that
# tests/scripts/draft-release.test.ts can run it against a stub gh.
# Needs gh with GH_TOKEN, jq and awk. Runs on bash 3.2 and later.
set -euo pipefail
tag="$GITHUB_REF_NAME"
release_error="$RUNNER_TEMP/release-view.stderr"
if release="$(gh release view "$tag" --json isDraft,name 2> "$release_error")"; then
  cat "$release_error"
  is_draft="$(jq -r '.isDraft' <<< "$release")"
  title="$(jq -r '.name' <<< "$release")"
  if [[ "$title" != *"$tag"* ]]; then
    gh release edit "$tag" --title "$tag"
  fi
  if [[ "$is_draft" == true ]]; then
    gh release upload "$tag" main.js manifest.json styles.css --clobber
  else
    echo "::warning::Published files were left as they are; this run's attestations describe this run's build."
  fi
# gh release view prints this text when the tag has neither a published release nor a draft.
elif grep -Fq 'release not found' "$release_error"; then
  echo "No release for $tag yet; creating a draft."
  notes_file="$RUNNER_TEMP/release-notes.md"
  awk -v v="$tag" '/^## /{p=($2==v);next} p' CHANGELOG.md > "$notes_file"
  if [[ ! -s "$notes_file" ]]; then
    echo "::error::No CHANGELOG.md notes found for $tag."
    exit 1
  fi
  gh release create "$tag" main.js manifest.json styles.css \
    --draft --title "$tag" --notes-file "$notes_file"
else
  cat "$release_error"
  echo "::error::Release state for tag $tag could not be read."
  exit 1
fi
