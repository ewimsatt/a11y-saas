# Bootstrap Phase 2 (BullMQ Queues + Diff + Evidence Serving)

## Setup
1. `docker compose up postgres redis`
2. `cp .env.example .env`
3. `pnpm i`  # installs bullmq, ioredis, zod, @fastify/static etc.
4. `pnpm prisma db push`
5. `pnpm prisma generate`
6. `pnpm --filter @a11y/scanner exec playwright install`
7. **Term 1:** `cd apps/api && pnpm dev`  # http://localhost:3001
8. **Term 2:** `cd apps/worker && pnpm dev`  # BullMQ workers

*Note: Add `\"dev\": \"tsx src/index.ts\"` to apps/*/package.json if tsx not in scripts.*

## Test
```bash
# Create project (returns project ID)
PROJ_ID=$(curl -s -X POST http://localhost:3001/projects \\
  -H \"Content-Type: application/json\" \\
  -d '{\"name\":\"test\",\"baseUrl\":\"https://www.w3.org/WAI/demos/2019/color-contrast/\"}' | jq -r .id)

# Run scan
SCAN_ID=$(curl -s -X POST http://localhost:3001/scans/$PROJ_ID/run -d '{}' | jq -r .scanId)

# Wait ~30-60s for queues: queued -> crawling -> analyzing -> diffing -> evidence -> completed

# List issues (OPEN, FIXED, REGRESSED)
curl http://localhost:3001/scans/$SCAN_ID/issues

# Serve evidence screenshot
curl -I http://localhost:3001/evidence/pages/$PAGE_ID.png  # from issues response

# List projects
curl http://localhost:3001/projects
```

## Status Flow
- **queued** → **crawling** (screenshots) → **analyzing** (axe violations + findings) → **diffing** (NEW=OPEN, FIXED prev gone, REGRESSED=prev FIXED now back) → **evidence** (mark completed)

Evidence PNGs: `evidence/pages/*.png` (full page), served via `/evidence/pages/{pageId}.png`
