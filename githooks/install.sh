#!/bin/bash
# One-time setup: point git at the versioned hooks in githooks/ instead of
# the default (unversioned, local-only) .git/hooks. Run once per clone:
#   bash githooks/install.sh
set -e
cd "$(git rev-parse --show-toplevel)"
chmod +x githooks/pre-commit githooks/commit-msg githooks/pre-push githooks/post-commit
git config core.hooksPath githooks
echo "Git hooks installed (core.hooksPath = githooks)."
