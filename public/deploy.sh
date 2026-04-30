#!/bin/bash
# FrontFrame — Cloudflare Pages Deploy
# Run from the root of your site directory

set -e

PROJECT_NAME="frontframe-site"
DIST_DIR="."                # root of site — adjust if your files live in a subfolder

echo "Deploying FrontFrame to Cloudflare Pages..."
npx wrangler pages deploy "$DIST_DIR" --project-name "$PROJECT_NAME"

echo "Done. Visit https://dash.cloudflare.com to confirm the deployment."
