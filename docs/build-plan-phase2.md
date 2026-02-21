# Build Plan — Phase 2 (BullMQ + Full Pipeline)

> Generated 2026-02-21. Living doc — update as tasks land.

---

## 1. Architecture Snapshot

```
┌─────────┐  HTTP   ┌─────────┐  BullMQ   ┌──────────┐
│  Web UI │◄──────►│   API   │──────────►│  Worker  │
│ (Next?) │        │ Express │           │ 4 queues │
└─────────┘        └────┬────┘           └────┬─────┘
                        │ Prisma              │ Playwright+axe
                   ┌────▼────┐           ┌────▼─────┐
                   │Postgres │           │  MinIO   │
                   │  16     │           │(evidence)│
                   └─────────┘           └──────────┘
                        ▲
                        │
                   ┌────┴────┐
                   │  Redis  │  (BullMQ broker)
                   └─────────┘
```

**Packages:** `@a11y/db` (Prisma) · `@a11y/scanner` (axe adapter + fingerprint) · `@a11y/shared` (DTOs) · `@a11y/config`

**Apps:** `@a11y/api` (Express routes: projects, scans, issues) · `@a11y/worker` (crawl → analyze → diff → evidence queues) · `@a11y/web` (empty shell)

**Infra:** docker-compose (Postgres 16, Redis 7, MinIO)

**DB models:** Project → Scan → Page → Finding → Evidence/Waiver; Rule table; Finding has fingerprint-based dedup + diff status (OPEN/FIXED/REGRESSED/WAIVED)

---

## 2. Task Board

### 🔴 Now (sprint 1 — foundation gaps)

| # | Task | Lane | Depends on |
|---|------|------|------------|
| N1 | Wire `@a11y/db` exports — Prisma client + generated types reusable by api & worker | db | — |
| N2 | `@a11y/config` — env schema (zod), single source for DB_URL, REDIS_URL, MINIO_* | config | — |
| N3 | Worker: implement crawl processor (fetch sitemap / link-follow, enqueue pages) | worker | N1, N2 |
| N4 | Worker: implement analyze processor (Playwright + axe per page, upsert Finding) | worker | N1, N3 |
| N5 | Worker: implement diff processor (compare scan N vs N-1, set FIXED/REGRESSED) | worker | N1, N4 |
| N6 | Worker: implement evidence processor (screenshot → MinIO, DOM snippet → Evidence row) | worker | N1, N5 |
| N7 | API: `GET /projects/:id/issues` with pagination, severity/status filters | api | N1 |
| N8 | Seed script: update `scripts/seed.js` to create project + trigger scan via API | api | N7 |

### 🟡 Next (sprint 2 — web + polish)

| # | Task | Lane | Depends on |
|---|------|------|------------|
| X1 | Web: scaffold Next.js app, project list + scan detail pages | web | N7 |
| X2 | API: `POST /issues/:id/waive`, `DELETE /waivers/:id` | api | N1 |
| X3 | Worker: retry / dead-letter config per queue; BullMQ dashboard (bull-board) | worker | N3-N6 |
| X4 | API: webhook/callback on scan completion | api | N5 |
| X5 | CI: GitHub Actions — lint, type-check, Prisma migrate, integration test | all | N1-N8 |

### 🟢 Later (sprint 3+ — scale & features)

| # | Task | Lane |
|---|------|------|
| L1 | Auth: API keys + JWT for web | api/web |
| L2 | Multi-tenant: org model, row-level security | db |
| L3 | Scheduled scans (cron triggers via BullMQ repeatable jobs) | worker |
| L4 | PDF/CSV report export | api |
| L5 | WCAG conformance scoring & trend graphs | web |

---

## 3. Dependency Order

```
@a11y/config ─┐
               ├─► @a11y/db ─┬─► @a11y/api
               │              └─► @a11y/worker
@a11y/shared ──┤
               └─► @a11y/scanner ──► @a11y/worker
                                         │
                          @a11y/web ◄────┘ (via API, no direct dep)
```

**Build order:** config → shared → db (prisma generate) → scanner → api | worker → web

---

## 4. Acceptance Checks

### DB (`@a11y/db`)
- [ ] `prisma migrate dev` runs clean against docker Postgres
- [ ] `prisma generate` produces client importable from api & worker
- [ ] Seed script creates ≥1 project with findings
- [ ] `@@unique([scanId, fingerprint])` prevents duplicate findings

### API (`@a11y/api`)
- [ ] `POST /projects` → 201 with cuid id
- [ ] `POST /scans/:pid/run` → 202, job visible in Redis
- [ ] `GET /projects/:id/issues?severity=CRITICAL&status=OPEN` → filtered results
- [ ] Zod validation rejects bad payloads with 422
- [ ] Health endpoint `GET /health` returns `{ ok: true }`

### Worker (`@a11y/worker`)
- [ ] Crawl processor discovers ≥N pages from baseUrl (configurable max)
- [ ] Analyze processor creates Finding rows with valid fingerprints
- [ ] Diff processor marks prior-scan findings as FIXED when absent, REGRESSED when reappear
- [ ] Evidence processor uploads screenshot to MinIO, writes Evidence row
- [ ] Failed jobs land in dead-letter after 3 retries
- [ ] Scan status transitions: queued → crawling → analyzing → diffing → complete

### Web (`@a11y/web`)
- [ ] `pnpm dev` starts on :3000
- [ ] Project list page renders projects from API
- [ ] Scan detail shows findings grouped by severity
- [ ] Evidence screenshots load from MinIO presigned URLs

---

## 5. Rollback / Debug Checklist

| Scenario | Action |
|----------|--------|
| **Bad migration** | `prisma migrate resolve --rolled-back <name>`, then fix & re-migrate |
| **Worker stuck** | Check `bull-board` or `redis-cli LLEN bull:crawl:wait`; drain with `Queue.obliterate()` |
| **Scan hangs** | Query `Scan` where `status != 'complete'` and `startedAt < NOW() - 30min`; re-enqueue or mark failed |
| **MinIO unreachable** | Evidence processor should catch & retry; check `docker logs minio`; verify `MINIO_ENDPOINT` env |
| **Fingerprint drift** | If fingerprint algo changes, old findings won't match → run backfill script or accept one "all new" scan |
| **Redis OOM** | Set `maxmemory-policy allkeys-lru` in Redis config; monitor with `redis-cli INFO memory` |
| **Prisma client mismatch** | `pnpm --filter @a11y/db prisma generate` then restart consumers |
| **Full reset (dev)** | `docker compose down -v && docker compose up -d && pnpm --filter @a11y/db prisma migrate dev && pnpm seed` |
