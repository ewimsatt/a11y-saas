# A11Y SaaS — Open Source Accessibility Scanner

Automated WCAG 2.0 A/AA scanning with fingerprint-based diff tracking.

**Core flow:** `scan run → crawl → axe analyze → diff (OPEN/FIXED/REGRESSED) → evidence screenshots`

---

## Quickstart

> **Full step-by-step:** `docs/first-scan-tonight.md`  
> **What's implemented:** `docs/current-scope.md`

```bash
# 1. Infra
docker compose up -d

# 2. Deps
pnpm install

# 3. DB
cp .env.example .env
pnpm --filter @a11y/db exec -- npx prisma migrate dev --name init
pnpm --filter @a11y/db exec -- npx prisma generate

# 4. Playwright browsers (one-time)
pnpm --filter @a11y/scanner exec -- npx playwright install chromium

# 5. Start (two terminals)
cd apps/api && npx tsx src/index.ts       # :3001
cd apps/worker && npx tsx src/index.ts    # BullMQ workers

# 6. Scan
PROJ_ID=$(curl -s -X POST http://localhost:3001/ \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","baseUrl":"https://www.w3.org/WAI/demos/2019/color-contrast/"}' \
  | jq -r .id)

SCAN_ID=$(curl -s -X POST "http://localhost:3001/scans/$PROJ_ID/run" \
  -H "Content-Type: application/json" -d '{}' | jq -r .scanId)

# Wait ~60s, then:
curl "http://localhost:3001/scans/$SCAN_ID/issues" | jq '.issues | length'
```

---

## Monorepo

| Package | Purpose |
|---------|---------|
| `apps/api` | Fastify REST API (port 3001) |
| `apps/worker` | BullMQ workers: crawl → analyze → diff → evidence |
| `apps/web` | Web UI (empty shell — not yet built) |
| `packages/scanner` | Playwright + axe-core adapter + fingerprint |
| `packages/db` | Prisma client + schema |
| `packages/shared` | Shared TypeScript types |
| `packages/config` | Env/config (placeholder) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | List projects |
| `POST` | `/` | Create project `{name, baseUrl}` |
| `POST` | `/scans/:projectId/run` | Run scan (enqueues to BullMQ) |
| `GET` | `/scans/:id/issues` | List findings for scan |
| `GET` | `/evidence/pages/:pageId.png` | Serve evidence screenshot |

## Docs

- `docs/first-scan-tonight.md` — exact commands to run your first scan
- `docs/current-scope.md` — what works now vs. not yet
- `docs/architecture.md` — system diagram
- `docs/bootstrap.md` — Phase 2 BullMQ setup notes
- `docs/build-plan-phase2.md` — sprint board and acceptance checks
