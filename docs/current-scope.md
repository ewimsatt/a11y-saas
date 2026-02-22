# Current Scope — What Works vs. Not Yet

> Updated: 2026-02-21 (after Phase 2 / BullMQ commit)

---

## ✅ Works Now

### Infra
- Docker Compose: Postgres 16, Redis 7, MinIO (MinIO running but not wired to evidence yet)
- Prisma schema: full DB models (Project → Scan → Page → Rule → Finding → Evidence → Waiver)
- Migrations via `prisma migrate dev`

### Scanner (`@a11y/scanner`)
- `crawlPage(url)` — Playwright screenshot + page title
- `analyzePage(url)` — Playwright + axe-core WCAG 2.0 A/AA violations
- `stableFingerprint({ruleId, pageUrl, selector, message})` — SHA-256 dedup key

### Worker (`@a11y/worker`)
Full BullMQ pipeline, all 4 queues implemented:
- **crawl** — screenshots each page, saves PNG to `evidence/pages/<pageId>.png`
- **analyze** — runs axe per page, upserts Rule + Finding + Evidence rows
- **diff** — compares to previous completed scan, marks findings FIXED / REGRESSED
- **evidence** — marks scan `completed` (screenshot already done in crawl stage)

### API (`@a11y/api`) — Fastify on :3001
| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | List all projects |
| `POST` | `/` | Create project `{name, baseUrl}` → 201 |
| `POST` | `/scans/:projectId/run` | Create scan + enqueue to BullMQ → 202 |
| `GET` | `/scans/:id/issues` | List findings (excludes WAIVED), includes rule + evidence |
| `GET` | `/evidence/pages/:pageId.png` | Static screenshot serving |

### Evidence
- Screenshots written to `evidence/pages/<pageId>.png` on local disk
- Served statically at `/evidence/pages/<pageId>.png`
- Evidence rows created in DB with screenshot path

---

## ⚠️ Stubs (code exists, logic missing)

| Endpoint | Status |
|----------|--------|
| `GET /:id/evidence` | Returns `{evidence: null}` — not yet wired to DB |
| `POST /:id/waive` | Returns 200 OK but does **not** write Waiver to DB or set status=WAIVED |

---

## ❌ Not Yet Built

### Web UI (`@a11y/web`)
- Empty shell — `pnpm dev` does nothing useful
- No project list, no scan detail, no issue view

### No `dev` scripts
- All three apps (`api`, `worker`, `web`) have no `scripts.dev` in package.json
- Must add manually or use `npx tsx src/index.ts` directly (see `docs/first-scan-tonight.md`)

### MinIO / S3 evidence
- MinIO runs in Docker but evidence processor doesn't upload to it
- Screenshots go to local `evidence/` folder (fine for dev, not production)

### Auth
- No API keys, no JWT, no auth middleware anywhere

### Multi-page crawl
- Scan only scans the `baseUrl` as a single page (unless you pass `urls` array in the scan request)
- No sitemap crawling or link-following implemented

### Waiver DB persistence
- Route accepts the request but `Waiver` table is never written to

### Retry / dead-letter
- BullMQ workers have no retry config — failed jobs vanish

### Web UI / Dashboard
- No bull-board or BullMQ dashboard wired

### CI
- No GitHub Actions workflow

---

## Sprint Board Snapshot

| ID | Task | Status |
|----|------|--------|
| a11y-01 | Playwright + axe scanner execution | in-progress |
| a11y-02 | Persist findings/evidence via Prisma | in-progress |
| a11y-03 | Queue pipeline (BullMQ) | backlog (code exists, needs test) |
| a11y-04 | Issues API contracts operational | backlog |
| a11y-05 | Mission Control visibility | done |
| a11y-06 | Kite QA gate | review |

---

## The Happy Path Tonight

A successful first scan end-to-end proves:
1. Docker infra up ✓
2. Prisma schema migrated ✓  
3. API accepts project/scan creation ✓
4. BullMQ workers run the full crawl → analyze → diff → evidence pipeline ✓
5. `GET /scans/:id/issues` returns real axe findings with severity + WCAG rule IDs ✓
6. Evidence PNGs on disk and served via HTTP ✓
