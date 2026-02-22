# First Scan Tonight — Exact Commands

> Assumes macOS, pnpm installed globally, Docker running.

---

## 1. Infra up

```bash
cd ~/frameworks/a11y-saas
docker compose up -d
```

Starts: Postgres :5432 · Redis :6379 · MinIO :9000 (MinIO not yet wired — ignore for now)

---

## 2. Install deps + add missing dev scripts

```bash
pnpm install
```

The apps have no `dev` script yet. Add them now (one-liner):

```bash
node -e "
const fs = require('fs');
['apps/api','apps/worker','apps/web'].forEach(p => {
  const f = p + '/package.json';
  const pkg = JSON.parse(fs.readFileSync(f));
  pkg.scripts = { ...(pkg.scripts||{}), dev: 'tsx src/index.ts' };
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2));
});
console.log('Done');
"
```

---

## 3. DB — migrate + generate Prisma client

```bash
cp .env.example .env          # already there? skip

# Run migration (creates tables)
pnpm --filter @a11y/db exec -- npx prisma migrate dev --name init

# Generate client (must succeed before api/worker start)
pnpm --filter @a11y/db exec -- npx prisma generate
```

---

## 4. Install Playwright browsers (one-time)

```bash
pnpm --filter @a11y/scanner exec -- npx playwright install chromium
```

---

## 5. Start API + Worker (two terminals)

**Terminal 1 — API on :3001**

```bash
cd apps/api
npx tsx src/index.ts
```

**Terminal 2 — Worker (BullMQ)**

```bash
cd apps/worker
npx tsx src/index.ts
```

Watch both terminals. Worker should log:
```
Worker boot - BullMQ queues mode
Queues: crawl, analyze, diff, evidence
```

---

## 6. Run a scan

```bash
# Create project — note: endpoint is POST / (not /projects)
PROJ_ID=$(curl -s -X POST http://localhost:3001/ \
  -H "Content-Type: application/json" \
  -d '{"name":"w3c-demo","baseUrl":"https://www.w3.org/WAI/demos/2019/color-contrast/"}' \
  | jq -r .id)

echo "Project: $PROJ_ID"

# Trigger scan (scans the baseUrl as a single page by default)
SCAN_ID=$(curl -s -X POST "http://localhost:3001/scans/$PROJ_ID/run" \
  -H "Content-Type: application/json" \
  -d '{}' \
  | jq -r .scanId)

echo "Scan: $SCAN_ID"
```

---

## 7. Wait and poll

The pipeline takes **30–90 seconds** (Playwright + axe per page).
Watch the worker terminal for status transitions: `crawling → analyzing → diffing → completed`

Or poll:

```bash
# Check scan status in DB
pnpm --filter @a11y/db exec -- npx prisma studio   # UI at :5555

# Or query findings directly
curl "http://localhost:3001/scans/$SCAN_ID/issues" | jq '.issues | length'
curl "http://localhost:3001/scans/$SCAN_ID/issues" | jq '.issues[] | {rule:.ruleId, severity:.severity, msg:.message}'
```

---

## 8. List projects

```bash
curl http://localhost:3001/ | jq '.[].name'
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot find package '@a11y/db'` | Run `pnpm install` at monorepo root |
| `prisma: command not found` | Use `npx prisma` inside the filter command |
| Scan stuck in `queued` | Worker not running — check Terminal 2 |
| Playwright timeout | Target URL slow; try a simpler URL or increase timeout in `axeAdapter.ts` |
| Evidence PNGs missing | Check `evidence/pages/` in monorepo root; created automatically on first scan |
| Full reset | `docker compose down -v && docker compose up -d` then re-run step 3 |
