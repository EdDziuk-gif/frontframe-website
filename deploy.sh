#!/bin/bash
# FrontFrame site deploy script
# Usage: ./deploy.sh "commit message"
# Handles stale HEAD.lock, stages admin.html, commits, and pushes.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$1" ]; then
  echo "Usage: ./deploy.sh \"commit message\""
  exit 1
fi

for lock in HEAD.lock index.lock MERGE_HEAD.lock; do
  if [ -f "$SCRIPT_DIR/.git/$lock" ]; then
    echo "Removing stale $lock..."
    rm "$SCRIPT_DIR/.git/$lock"
  fi
done

cd "$SCRIPT_DIR"

echo "Verifying working copy..."
if ! grep -q "Review Queue\|review-queue\|rq-tbody" public/admin.html; then
  echo "WARNING: Expected content not found in admin.html. Aborting."
  exit 1
fi

git add public/admin.html
git commit -m "$1"
git push

echo "Site deployed."
