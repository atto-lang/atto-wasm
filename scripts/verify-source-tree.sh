#!/usr/bin/env bash
# Reject test inputs that are not the complete, clean Git commit tree.
# This checks the *working files* in addition to the recorded index/tree.
set -euo pipefail
head_tree="$(git rev-parse 'HEAD^{tree}')"
index_tree="$(git write-tree)"
if [[ "$head_tree" != "$index_tree" ]]; then
  echo "ERROR: checked-out index differs from HEAD Git tree" >&2
  exit 1
fi
if [[ -n "$(git diff --no-ext-diff --name-only HEAD --)" ]]; then
  echo "ERROR: tracked source files differ from checkout" >&2
  git diff --name-only HEAD -- >&2
  exit 1
fi
# Do not use --exclude-standard: ignored files can shadow compiler inputs.
if [[ -n "$(git ls-files --others)" ]]; then
  echo "ERROR: checkout includes untracked/ignored worktree files" >&2
  git ls-files --others >&2
  exit 1
fi
echo "EXACT_SOURCE_COMMIT=$(git rev-parse HEAD)"
echo "EXACT_SOURCE_TREE=$head_tree"
echo "PASS: complete tracked worktree, index and commit tree agree"
