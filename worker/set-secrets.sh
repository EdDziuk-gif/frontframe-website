#!/bin/bash
# Run this from the frontframe-worker directory
# Paste each value when prompted

npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put DOCUSEAL_API_KEY
npx wrangler secret put DOCUSEAL_WEBHOOK_SECRET
npx wrangler secret put SURGE_API_KEY
npx wrangler secret put VAULT_ENCRYPTION_KEY
npx wrangler secret put CAL_API_KEY
npx wrangler secret put CAL_WEBHOOK_SECRET
