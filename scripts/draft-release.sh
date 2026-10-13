#!/usr/bin/env bash
# The steps of .github/workflows/release.yml that talk to GitHub. They are a file
# so that tests/scripts/draft-release.test.ts can run them against a stub gh.
# Needs gh with GH_TOKEN, jq and awk. Runs on bash 3.2 and later.
#
#   draft-release.sh check  Before the build. Fails when the release state cannot
#                           be read, or when a draft would have to be created
#                           without notes. A published release keeps its files:
#                           the step output `published=true` tells the workflow
#                           to skip the build, the attestation and the draft.
#   draft-release.sh draft  After the attestation. Creates the draft, or replaces
#                           the files of an existing draft.
set -euo pipefail
tag="$GITHUB_REF_NAME"
notes_file="$RUNNER_TEMP/release-notes.md"

fail() {
  echo "::error::$1"
  exit 1
}

# Sets $state to none, draft or published and, when there is a release, $title.
read_release() {
  local release error_file="$RUNNER_TEMP/release-view.stderr"
  if release="$(gh release view "$tag" --json isDraft,name 2> "$error_file")"; then
    cat "$error_file"
    # Without -r a JSON string keeps its quotes, so only the booleans pass.
    case "$(jq '.isDraft' <<< "$release" || true)" in
      true) state=draft ;;
      false) state=published ;;
      *) fail "Release state for tag $tag could not be read." ;;
    esac
    title="$(jq -r '.name' <<< "$release")"
  # gh release view prints this line when the tag has neither a published release nor a draft.
  elif grep -Fxq 'release not found' "$error_file"; then
    state=none
  else
    cat "$error_file"
    fail "Release state for tag $tag could not be read."
  fi
}

# Writes the section of the tag in CHANGELOG.md to $notes_file. Only a new draft needs it.
write_notes() {
  awk -v v="$tag" '/^## /{p=($2==v);next} p' CHANGELOG.md > "$notes_file"
  [[ -s "$notes_file" ]] || fail "No CHANGELOG.md notes found for $tag."
}

# A title that already contains the tag keeps its other text.
retitle() {
  if [[ "$title" != *"$tag"* ]]; then
    gh release edit "$tag" --title "$tag"
  fi
}

case "${1:-}" in
  check)
    read_release
    case "$state" in
      none) write_notes ;;
      # The files of a draft are replaced after the attestation.
      draft) ;;
      published)
        retitle
        echo "::warning::Release $tag is already published. Its files were left as they are and nothing is built or attested."
        echo "published=true" >> "$GITHUB_OUTPUT"
        ;;
    esac
    ;;
  draft)
    read_release
    case "$state" in
      none)
        echo "No release for $tag yet; creating a draft."
        write_notes
        gh release create "$tag" main.js manifest.json styles.css \
          --draft --title "$tag" --notes-file "$notes_file"
        ;;
      draft)
        retitle
        gh release upload "$tag" main.js manifest.json styles.css --clobber
        ;;
      # Published while this run was building.
      published)
        retitle
        echo "::warning::Published files were left as they are; this run's attestations describe this run's build."
        ;;
    esac
    ;;
  *)
    echo "usage: draft-release.sh check|draft" >&2
    exit 2
    ;;
esac
