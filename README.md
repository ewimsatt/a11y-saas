# A11Y SaaS

[![Status](https://img.shields.io/badge/status-alpha-orange)](https://github.com/ewimsatt/a11y-saas)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Prisma](https://img.shields.io/badge/prisma-ORM-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Playwright](https://img.shields.io/badge/playwright-scanner-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![axe-core](https://img.shields.io/badge/axe--core-accessibility-663399)](https://github.com/dequelabs/axe-core)
[![Redis](https://img.shields.io/badge/redis-queue-DC382D?logo=redis&logoColor=white)](https://redis.io/)

Open-source accessibility scanning SaaS foundation.

It scans pages for WCAG issues, normalizes findings into stable fingerprints, stores evidence, and exposes API endpoints for triage workflows.

---

## Current maturity

**Alpha** - demo-ready vertical slice, not production-hardened.

Working now:
- Project creation
- Scan run enqueue
- Worker processing (crawl/analyze/diff/evidence lanes)
- Findings persistence
- Issues listing by scan
- Waive issue endpoint
- Evidence serving from local filesystem

Not finished:
- Full web app UX
- Multi-tenant auth
- Production storage integration (MinIO/S3 upload flow)
- Enterprise reliability/observability hardening

---

## Architecture

Core flow:

`scan run -> crawl -> analyze (Playwright + axe) -> normalize/fingerprint -> diff -> issues + evidence`

### Monorepo layout

- `apps/api` - Fastify API
- `apps/worker` - BullMQ workers
- `apps/web` - UI shell
- `packages/scanner` - scanner/fingerprint logic
- `packages/db` - Prisma schema + client
- `packages/shared` - shared types
- `packages/config` - config placeholder

---

## Quickstart (local)

### 1) Start infrastructure

```bash
docker compose up -d
```

### 2) Install dependencies

```bash
pnpm install
```

### 3) Configure env

```bash
cp .env.example .env
```

### 4) Prepare database

```bash
pnpm --filter @a11y/db db:generate
cd packages/db
npx prisma db push --accept-data-loss
cd ../..
```

### 5) Install Playwright browser

```bash
pnpm --filter @a11y/scanner pw:install
```

### 6) Run API + worker

```bash
pnpm --filter @a11y/api dev
# new terminal
pnpm --filter @a11y/worker dev
```

---

## First scan (curl)

```bash
# Create project
PROJECT_ID=$(curl -s -X POST http://localhost:3001/ \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo","baseUrl":"https://www.w3.org/WAI/demos/2019/color-contrast/"}' | jq -r .id)

# Start scan
SCAN_ID=$(curl -s -X POST "http://localhost:3001/scans/$PROJECT_ID/run" \
  -H 'Content-Type: application/json' -d '{}' | jq -r .scanId)

# Fetch issues (after worker completes)
curl -s "http://localhost:3001/scans/$SCAN_ID/issues" | jq
```

---

## API surface (current)

> Note: current issue endpoints are mounted at root path shape (`/:id/...`). A namespaced `/issues/:id/...` route is planned.

- `GET /` - list projects
- `POST /` - create project
- `POST /scans/:projectId/run` - enqueue scan
- `GET /scans/:id/issues` - list findings for scan
- `GET /:id/evidence` - get evidence for issue/finding id
- `POST /:id/waive` - waive issue/finding id
- `GET /evidence/*` - static evidence files

---

## Docs

- `docs/first-scan-tonight.md` - exact local run flow
- `docs/current-scope.md` - implemented vs pending
- `docs/qa-wrapup.md` - QA gate report
- `docs/architecture.md` - architecture diagram
- `docs/build-plan-phase2.md` - execution board

---

## Roadmap (short)

- [ ] Normalize endpoint naming (`/projects`, `/issues/:id/...`)
- [ ] Complete evidence API + object storage support
- [ ] Finish web Issues UI (filters, evidence pane, waivers)
- [ ] Add auth and multi-tenant boundaries
- [ ] CI smoke test for first-scan flow

---

## Contributing

PRs welcome for focused, incremental improvements.

Recommended scope for first contribution:
1. Pick one API contract gap
2. Add/update test fixture
3. Update docs with exact run command changes

---

## Disclaimer

This project helps detect accessibility issues. It does **not** guarantee legal compliance on its own. Manual audits remain essential.
